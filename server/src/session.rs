use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use zeroize::Zeroizing;

use crate::config::{INACTIVITY_TIMEOUT, JWT_EXPIRY_HOURS};
use crate::errors::AppError;

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String, // session ID
    pub exp: usize,
}

pub struct SessionData {
    pub encryption_key: Zeroizing<[u8; 32]>,
    pub last_activity: Instant,
}

#[derive(Clone)]
pub struct SessionStore {
    sessions: Arc<RwLock<HashMap<String, SessionData>>>,
    jwt_secret: Vec<u8>,
}

impl SessionStore {
    pub fn new() -> Self {
        let mut secret = vec![0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut secret);
        SessionStore {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            jwt_secret: secret,
        }
    }

    pub fn create_token(&self, session_id: &str) -> Result<String, jsonwebtoken::errors::Error> {
        let expiry = chrono::Utc::now()
            + chrono::Duration::hours(JWT_EXPIRY_HOURS as i64);
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
        sessions.insert(
            session_id,
            SessionData {
                encryption_key,
                last_activity: Instant::now(),
            },
        );
    }

    pub async fn get_encryption_key(&self, session_id: &str) -> Option<Zeroizing<[u8; 32]>> {
        let mut sessions = self.sessions.write().await;
        if let Some(session) = sessions.get_mut(session_id) {
            // Check inactivity timeout
            if session.last_activity.elapsed() > INACTIVITY_TIMEOUT {
                sessions.remove(session_id);
                return None;
            }
            session.last_activity = Instant::now();
            Some(session.encryption_key.clone())
        } else {
            None
        }
    }

    pub async fn remove_session(&self, session_id: &str) {
        let mut sessions = self.sessions.write().await;
        sessions.remove(session_id);
    }

    pub async fn cleanup_expired(&self) {
        let mut sessions = self.sessions.write().await;
        let timeout = INACTIVITY_TIMEOUT;
        sessions.retain(|_, data| data.last_activity.elapsed() < timeout);
    }
}

// Axum extractor for authenticated requests
pub struct AuthenticatedSession {
    pub session_id: String,
    pub encryption_key: Zeroizing<[u8; 32]>,
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
            })
        }
    }
}
