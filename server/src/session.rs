use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use chrono::{DateTime, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tokio::sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};
use zeroize::Zeroizing;

use crate::config::{inactivity_timeout, jwt_expiry_hours};
use crate::errors::AppError;

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String, // session ID
    pub exp: usize,
}

pub struct SessionData {
    pub encryption_key: Zeroizing<[u8; 32]>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Clone)]
pub struct SessionStore {
    sessions: Arc<RwLock<HashMap<String, SessionData>>>,
    operation_lock: Arc<RwLock<()>>,
    jwt_secret: Vec<u8>,
}

impl SessionStore {
    fn inactivity_timeout_chrono() -> chrono::Duration {
        let timeout_secs = inactivity_timeout().as_secs().min(i64::MAX as u64) as i64;
        chrono::Duration::seconds(timeout_secs)
    }

    fn next_expiry(from: DateTime<Utc>) -> DateTime<Utc> {
        from + Self::inactivity_timeout_chrono()
    }

    fn cleanup_expired_locked(
        sessions: &mut HashMap<String, SessionData>,
        now: DateTime<Utc>,
    ) -> usize {
        let before = sessions.len();
        sessions.retain(|_, data| data.expires_at > now);
        before - sessions.len()
    }

    pub fn new() -> Self {
        let mut secret = vec![0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut secret);
        SessionStore {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            operation_lock: Arc::new(RwLock::new(())),
            jwt_secret: secret,
        }
    }

    pub fn create_token(&self, session_id: &str) -> Result<String, jsonwebtoken::errors::Error> {
        let expiry = chrono::Utc::now() + chrono::Duration::hours(jwt_expiry_hours() as i64);
        let claims = Claims {
            sub: session_id.to_string(),
            exp: expiry.timestamp() as usize,
        };
        encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(&self.jwt_secret),
        )
    }

    pub fn validate_token(&self, token: &str) -> Result<Claims, jsonwebtoken::errors::Error> {
        let data = decode::<Claims>(
            token,
            &DecodingKey::from_secret(&self.jwt_secret),
            &Validation::default(),
        )?;
        Ok(data.claims)
    }

    pub async fn create_session(&self, session_id: String, encryption_key: Zeroizing<[u8; 32]>) {
        let mut sessions = self.sessions.write().await;
        let now = Utc::now();
        Self::cleanup_expired_locked(&mut sessions, now);
        sessions.insert(
            session_id,
            SessionData {
                encryption_key,
                expires_at: Self::next_expiry(now),
            },
        );
    }

    pub async fn begin_shared_operation(&self) -> OwnedRwLockReadGuard<()> {
        self.operation_lock.clone().read_owned().await
    }

    pub async fn begin_exclusive_rekey(&self) -> OwnedRwLockWriteGuard<()> {
        self.operation_lock.clone().write_owned().await
    }

    pub async fn get_encryption_key(&self, session_id: &str) -> Option<Zeroizing<[u8; 32]>> {
        let mut sessions = self.sessions.write().await;
        let now = Utc::now();
        Self::cleanup_expired_locked(&mut sessions, now);
        if let Some(session) = sessions.get_mut(session_id) {
            // Use wall-clock timestamps so inactivity still expires across suspend/sleep.
            session.expires_at = Self::next_expiry(now);
            Some(session.encryption_key.clone())
        } else {
            None
        }
    }

    pub async fn has_active_session(&self, session_id: &str) -> bool {
        let mut sessions = self.sessions.write().await;
        Self::cleanup_expired_locked(&mut sessions, Utc::now());
        sessions.contains_key(session_id)
    }

    pub async fn remove_session(&self, session_id: &str) {
        let mut sessions = self.sessions.write().await;
        sessions.remove(session_id);
    }

    pub async fn clear_sessions(&self) {
        let mut sessions = self.sessions.write().await;
        sessions.clear();
    }

    pub async fn cleanup_expired(&self) -> usize {
        let mut sessions = self.sessions.write().await;
        Self::cleanup_expired_locked(&mut sessions, Utc::now())
    }
}

// Axum extractor for authenticated requests
pub struct AuthenticatedSession {
    pub session_id: String,
    pub encryption_key: Zeroizing<[u8; 32]>,
    operation_guard: Option<OwnedRwLockReadGuard<()>>,
}

impl AuthenticatedSession {
    pub fn release_operation_lock(&mut self) {
        self.operation_guard.take();
    }
}

impl FromRequestParts<crate::AppState> for AuthenticatedSession {
    type Rejection = AppError;

    fn from_request_parts(
        parts: &mut Parts,
        state: &crate::AppState,
    ) -> impl std::future::Future<Output = Result<Self, Self::Rejection>> + Send {
        let session_store = state.sessions.clone();
        let auth_header = parts
            .headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());

        async move {
            let operation_guard = session_store.begin_shared_operation().await;

            let header = auth_header
                .ok_or_else(|| AppError::Unauthorized("Missing Authorization header".into()))?;

            let token = header
                .strip_prefix("Bearer ")
                .ok_or_else(|| AppError::Unauthorized("Invalid Authorization format".into()))?;

            let claims = session_store
                .validate_token(token)
                .map_err(|_| AppError::Unauthorized("Invalid or expired token".into()))?;

            let encryption_key = session_store
                .get_encryption_key(&claims.sub)
                .await
                .ok_or_else(|| AppError::Unauthorized("Session expired or not found".into()))?;

            Ok(AuthenticatedSession {
                session_id: claims.sub,
                encryption_key,
                operation_guard: Some(operation_guard),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key(byte: u8) -> Zeroizing<[u8; 32]> {
        Zeroizing::new([byte; 32])
    }

    #[tokio::test]
    async fn cleanup_expired_removes_only_expired_sessions() {
        let store = SessionStore::new();
        store
            .create_session("active".to_string(), test_key(1))
            .await;

        {
            let mut sessions = store.sessions.write().await;
            sessions.insert(
                "expired".to_string(),
                SessionData {
                    encryption_key: test_key(2),
                    expires_at: Utc::now() - chrono::Duration::seconds(1),
                },
            );
        }

        assert_eq!(store.cleanup_expired().await, 1);
        assert!(store.has_active_session("active").await);
        assert!(!store.has_active_session("expired").await);
    }

    #[tokio::test]
    async fn session_access_opportunistically_cleans_other_expired_sessions() {
        let store = SessionStore::new();
        store
            .create_session("active".to_string(), test_key(1))
            .await;

        {
            let mut sessions = store.sessions.write().await;
            sessions.insert(
                "expired".to_string(),
                SessionData {
                    encryption_key: test_key(2),
                    expires_at: Utc::now() - chrono::Duration::seconds(1),
                },
            );
        }

        assert!(store.get_encryption_key("active").await.is_some());

        let sessions = store.sessions.read().await;
        assert!(sessions.contains_key("active"));
        assert!(!sessions.contains_key("expired"));
    }
}
