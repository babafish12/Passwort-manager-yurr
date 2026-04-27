use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use axum::extract::State;
use axum::Json;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;

use crate::config::{LOGIN_RATE_LIMIT_BURST, LOGIN_RATE_LIMIT_PER_SECOND};
use crate::crypto;
use crate::errors::AppError;
use crate::models::*;
use crate::session::AuthenticatedSession;
use crate::AppState;

struct RateBucket {
    tokens: f64,
    last_refill: Instant,
}

struct AuthRateLimiter {
    buckets: HashMap<&'static str, RateBucket>,
}

impl AuthRateLimiter {
    fn new() -> Self {
        Self {
            buckets: HashMap::new(),
        }
    }

    fn allow(&mut self, bucket_name: &'static str) -> bool {
        let now = Instant::now();
        let burst = LOGIN_RATE_LIMIT_BURST.max(1) as f64;
        let refill_per_second = LOGIN_RATE_LIMIT_PER_SECOND.max(1) as f64;
        let bucket = self
            .buckets
            .entry(bucket_name)
            .or_insert_with(|| RateBucket {
                tokens: burst,
                last_refill: now,
            });

        let elapsed = now.duration_since(bucket.last_refill).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * refill_per_second).min(burst);
        bucket.last_refill = now;

        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

fn enforce_auth_rate_limit(bucket_name: &'static str) -> Result<(), AppError> {
    static LIMITER: OnceLock<Mutex<AuthRateLimiter>> = OnceLock::new();
    let limiter = LIMITER.get_or_init(|| Mutex::new(AuthRateLimiter::new()));
    let mut limiter = limiter
        .lock()
        .map_err(|_| AppError::Internal("Auth rate limiter lock poisoned".into()))?;

    if limiter.allow(bucket_name) {
        Ok(())
    } else {
        Err(AppError::RateLimited)
    }
}

pub async fn status(State(state): State<AppState>) -> Result<Json<AuthStatusResponse>, AppError> {
    let row: Option<(i64,)> = sqlx::query_as("SELECT id FROM master_config WHERE id = 1")
        .fetch_optional(&state.db)
        .await?;

    Ok(Json(AuthStatusResponse {
        initialized: row.is_some(),
        server_version: env!("CARGO_PKG_VERSION").to_string(),
    }))
}

pub async fn setup(
    State(state): State<AppState>,
    Json(req): Json<SetupRequest>,
) -> Result<Json<MessageResponse>, AppError> {
    enforce_auth_rate_limit("setup")?;
    let _auth_guard = state.sessions.begin_shared_operation().await;

    if req.master_password.len() < 8 {
        return Err(AppError::BadRequest(
            "Master password must be at least 8 characters".into(),
        ));
    }

    let existing: Option<(i64,)> = sqlx::query_as("SELECT id FROM master_config WHERE id = 1")
        .fetch_optional(&state.db)
        .await?;

    if existing.is_some() {
        return Err(AppError::Conflict("Vault is already initialized".into()));
    }

    let pw = req.master_password.clone();
    let password_hash = tokio::task::spawn_blocking(move || crypto::hash_master_password(&pw))
        .await
        .map_err(|e| AppError::Internal(format!("Task join error: {e}")))?
        .map_err(|e| AppError::Internal(format!("Hashing failed: {e}")))?;

    let encryption_salt = crypto::generate_encryption_salt();

    sqlx::query("INSERT INTO master_config (id, password_hash, encryption_salt) VALUES (1, ?, ?)")
        .bind(&password_hash)
        .bind(&encryption_salt)
        .execute(&state.db)
        .await?;

    sqlx::query(
        "INSERT INTO audit_log (event_type, details) VALUES ('SETUP', 'Vault initialized')",
    )
    .execute(&state.db)
    .await?;

    Ok(Json(MessageResponse {
        message: "Vault initialized successfully".into(),
    }))
}

pub async fn login(
    State(state): State<AppState>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, AppError> {
    enforce_auth_rate_limit("login")?;
    let _auth_guard = state.sessions.begin_shared_operation().await;

    let config: MasterConfigRow =
        sqlx::query_as("SELECT password_hash, encryption_salt FROM master_config WHERE id = 1")
            .fetch_optional(&state.db)
            .await?
            .ok_or_else(|| {
                AppError::BadRequest("Vault not initialized. Call /auth/setup first".into())
            })?;

    // Run argon2 verification off the async runtime
    let pw = req.master_password.clone();
    let hash = config.password_hash.clone();
    let valid = tokio::task::spawn_blocking(move || crypto::verify_master_password(&pw, &hash))
        .await
        .map_err(|e| AppError::Internal(format!("Task join error: {e}")))?;

    if !valid {
        sqlx::query("INSERT INTO audit_log (event_type, details) VALUES ('LOGIN_FAILED', 'Invalid password')")
            .execute(&state.db)
            .await?;
        return Err(AppError::Unauthorized("Invalid master password".into()));
    }

    // Derive encryption key off the async runtime
    let salt_bytes = B64
        .decode(&config.encryption_salt)
        .map_err(|e| AppError::Internal(format!("Salt decode failed: {e}")))?;
    let pw2 = req.master_password.clone();
    let encryption_key =
        tokio::task::spawn_blocking(move || crypto::derive_encryption_key(&pw2, &salt_bytes))
            .await
            .map_err(|e| AppError::Internal(format!("Task join error: {e}")))?;

    let session_id = uuid::Uuid::new_v4().to_string();
    let token = state
        .sessions
        .create_token(&session_id)
        .map_err(|e| AppError::Internal(format!("Token creation failed: {e}")))?;

    state
        .sessions
        .create_session(session_id, encryption_key)
        .await;

    sqlx::query(
        "INSERT INTO audit_log (event_type, details) VALUES ('LOGIN_SUCCESS', 'User logged in')",
    )
    .execute(&state.db)
    .await?;

    Ok(Json(LoginResponse { token }))
}

pub async fn logout(
    State(state): State<AppState>,
    session: AuthenticatedSession,
) -> Result<Json<MessageResponse>, AppError> {
    state.sessions.remove_session(&session.session_id).await;

    sqlx::query("INSERT INTO audit_log (event_type, details) VALUES ('LOGOUT', 'User logged out')")
        .execute(&state.db)
        .await?;

    Ok(Json(MessageResponse {
        message: "Logged out successfully".into(),
    }))
}

pub async fn session(_session: AuthenticatedSession) -> Result<Json<MessageResponse>, AppError> {
    Ok(Json(MessageResponse {
        message: "Session is valid".into(),
    }))
}

pub async fn change_password(
    State(state): State<AppState>,
    mut session: AuthenticatedSession,
    Json(req): Json<ChangePasswordRequest>,
) -> Result<Json<MessageResponse>, AppError> {
    if req.new_password.len() < 8 {
        return Err(AppError::BadRequest(
            "New password must be at least 8 characters".into(),
        ));
    }

    let config: MasterConfigRow =
        sqlx::query_as("SELECT password_hash, encryption_salt FROM master_config WHERE id = 1")
            .fetch_one(&state.db)
            .await?;

    let pw = req.current_password.clone();
    let hash = config.password_hash.clone();
    let valid = tokio::task::spawn_blocking(move || crypto::verify_master_password(&pw, &hash))
        .await
        .map_err(|e| AppError::Internal(format!("Task join error: {e}")))?;

    if !valid {
        return Err(AppError::Unauthorized(
            "Current password is incorrect".into(),
        ));
    }

    let new_pw = req.new_password.clone();
    let new_hash = tokio::task::spawn_blocking(move || crypto::hash_master_password(&new_pw))
        .await
        .map_err(|e| AppError::Internal(format!("Task join error: {e}")))?
        .map_err(|e| AppError::Internal(format!("Hashing failed: {e}")))?;

    let new_salt = crypto::generate_encryption_salt();
    let new_salt_bytes = B64
        .decode(&new_salt)
        .map_err(|e| AppError::Internal(format!("Salt decode failed: {e}")))?;
    let new_pw2 = req.new_password.clone();
    let new_key = tokio::task::spawn_blocking(move || {
        crypto::derive_encryption_key(&new_pw2, &new_salt_bytes)
    })
    .await
    .map_err(|e| AppError::Internal(format!("Task join error: {e}")))?;

    session.release_operation_lock();
    let _rekey_guard = state.sessions.begin_exclusive_rekey().await;

    if !state.sessions.has_active_session(&session.session_id).await {
        return Err(AppError::Unauthorized(
            "Session expired or not found".into(),
        ));
    }

    let mut conn = state.db.acquire().await?;
    sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;

    let rekey_result: Result<(), AppError> = async {
        let config: MasterConfigRow = sqlx::query_as(
            "SELECT password_hash, encryption_salt FROM master_config WHERE id = 1",
        )
        .fetch_one(&mut *conn)
        .await?;

        let pw = req.current_password.clone();
        let hash = config.password_hash.clone();
        let valid = tokio::task::spawn_blocking(move || crypto::verify_master_password(&pw, &hash))
            .await
            .map_err(|e| AppError::Internal(format!("Task join error: {e}")))?;

        if !valid {
            return Err(AppError::Unauthorized("Current password is incorrect".into()));
        }

        let old_key = &session.encryption_key;
        let entries: Vec<EntryRow> = sqlx::query_as(
            "SELECT id, website_url, website_domain, username, password_encrypted, notes_encrypted, favorite, created_at, updated_at FROM entries",
        )
        .fetch_all(&mut *conn)
        .await?;

        for entry in &entries {
            let decrypted_pw = crypto::decrypt(&entry.password_encrypted, old_key)
                .map_err(|e| AppError::Internal(format!("Decrypt failed: {e}")))?;
            let new_encrypted_pw = crypto::encrypt(&decrypted_pw, &new_key)
                .map_err(|e| AppError::Internal(format!("Encrypt failed: {e}")))?;

            let new_encrypted_notes = if let Some(ref notes_enc) = entry.notes_encrypted {
                let decrypted_notes = crypto::decrypt(notes_enc, old_key)
                    .map_err(|e| AppError::Internal(format!("Decrypt notes failed: {e}")))?;
                Some(
                    crypto::encrypt(&decrypted_notes, &new_key)
                        .map_err(|e| AppError::Internal(format!("Encrypt notes failed: {e}")))?,
                )
            } else {
                None
            };

            sqlx::query(
                "UPDATE entries SET password_encrypted = ?, notes_encrypted = ?, updated_at = datetime('now') WHERE id = ?",
            )
            .bind(&new_encrypted_pw)
            .bind(&new_encrypted_notes)
            .bind(&entry.id)
            .execute(&mut *conn)
            .await?;
        }

        let vault_items: Vec<VaultItemRow> = sqlx::query_as(
            "SELECT id, item_type, payload_encrypted, created_at, updated_at FROM vault_items",
        )
        .fetch_all(&mut *conn)
        .await?;

        for item in &vault_items {
            let decrypted_payload = crypto::decrypt(&item.payload_encrypted, old_key)
                .map_err(|e| AppError::Internal(format!("Decrypt vault item failed: {e}")))?;
            let new_encrypted_payload = crypto::encrypt(&decrypted_payload, &new_key)
                .map_err(|e| AppError::Internal(format!("Encrypt vault item failed: {e}")))?;

            sqlx::query(
                "UPDATE vault_items SET payload_encrypted = ?, updated_at = datetime('now') WHERE id = ?",
            )
            .bind(&new_encrypted_payload)
            .bind(&item.id)
            .execute(&mut *conn)
            .await?;
        }

        sqlx::query(
            "UPDATE master_config SET password_hash = ?, encryption_salt = ?, updated_at = datetime('now') WHERE id = 1",
        )
        .bind(&new_hash)
        .bind(&new_salt)
        .execute(&mut *conn)
        .await?;

        sqlx::query(
            "INSERT INTO audit_log (event_type, details) VALUES ('PASSWORD_CHANGED', 'Master password changed, all vault data re-encrypted and sessions invalidated')",
        )
        .execute(&mut *conn)
        .await?;

        Ok(())
    }
    .await;

    match rekey_result {
        Ok(()) => {
            if let Err(err) = sqlx::query("COMMIT").execute(&mut *conn).await {
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                return Err(err.into());
            }
        }
        Err(err) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            return Err(err);
        }
    }

    state.sessions.clear_sessions().await;

    Ok(Json(MessageResponse {
        message: "Password changed. Please log in again.".into(),
    }))
}
