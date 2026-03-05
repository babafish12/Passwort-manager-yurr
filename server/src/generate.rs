use axum::Json;

use crate::crypto;
use crate::errors::AppError;
use crate::models::*;
use crate::session::AuthenticatedSession;

pub async fn generate_password(
    _session: AuthenticatedSession,
    Json(req): Json<GeneratePasswordRequest>,
) -> Result<Json<GeneratePasswordResponse>, AppError> {
    let length = req.length.unwrap_or(20);
    let uppercase = req.uppercase.unwrap_or(true);
    let lowercase = req.lowercase.unwrap_or(true);
    let digits = req.digits.unwrap_or(true);
    let symbols = req.symbols.unwrap_or(true);

    if length < 4 || length > 128 {
        return Err(AppError::BadRequest(
            "Password length must be between 4 and 128".into(),
        ));
    }

    let password = crypto::generate_password(length, uppercase, lowercase, digits, symbols);

    Ok(Json(GeneratePasswordResponse { password }))
}
