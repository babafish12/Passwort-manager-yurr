use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::Value;

use crate::crypto;
use crate::errors::AppError;
use crate::models::*;
use crate::session::AuthenticatedSession;
use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct ListVaultItemsQuery {
    #[serde(rename = "type")]
    pub item_type: Option<String>,
}

pub fn validate_item_type(item_type: &str) -> Result<(), AppError> {
    match item_type {
        "card" | "address" | "passkey" => Ok(()),
        _ => Err(AppError::BadRequest(
            "item_type must be 'card', 'address', or 'passkey'".into(),
        )),
    }
}

fn non_empty_payload_string<'a>(payload: &'a Value, key: &str) -> Option<&'a str> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

pub fn validate_vault_item_payload(item_type: &str, payload: &Value) -> Result<(), AppError> {
    validate_item_type(item_type)?;

    if item_type != "passkey" {
        return Ok(());
    }

    let required = ["rp_id", "user_name", "credential_id"];
    let missing = required
        .iter()
        .find(|key| non_empty_payload_string(payload, key).is_none());

    if let Some(key) = missing {
        return Err(AppError::BadRequest(format!(
            "passkey payload requires non-empty {key}"
        )));
    }

    Ok(())
}

pub fn decrypt_vault_item(
    row: VaultItemRow,
    encryption_key: &[u8; 32],
) -> Result<VaultItemDetail, AppError> {
    let payload_json = crypto::decrypt(&row.payload_encrypted, encryption_key)
        .map_err(|e| AppError::Internal(format!("Decrypt vault item failed: {e}")))?;
    let payload = serde_json::from_str(&payload_json)
        .map_err(|e| AppError::Internal(format!("Decode vault item JSON failed: {e}")))?;

    Ok(VaultItemDetail {
        id: row.id,
        item_type: row.item_type,
        payload,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

async fn fetch_item(state: &AppState, id: &str) -> Result<VaultItemRow, AppError> {
    sqlx::query_as(
        "SELECT id, item_type, payload_encrypted, created_at, updated_at FROM vault_items WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Vault item not found".into()))
}

pub async fn list_vault_items(
    State(state): State<AppState>,
    session: AuthenticatedSession,
    Query(query): Query<ListVaultItemsQuery>,
) -> Result<Json<Vec<VaultItemDetail>>, AppError> {
    let rows: Vec<VaultItemRow> = if let Some(item_type) = query.item_type {
        validate_item_type(&item_type)?;
        sqlx::query_as(
            "SELECT id, item_type, payload_encrypted, created_at, updated_at FROM vault_items WHERE item_type = ? ORDER BY created_at DESC",
        )
        .bind(&item_type)
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query_as(
            "SELECT id, item_type, payload_encrypted, created_at, updated_at FROM vault_items ORDER BY item_type, created_at DESC",
        )
        .fetch_all(&state.db)
        .await?
    };

    let items = rows
        .into_iter()
        .map(|row| decrypt_vault_item(row, &session.encryption_key))
        .collect::<Result<Vec<_>, _>>()?;

    sqlx::query("INSERT INTO audit_log (event_type, details) VALUES ('LIST_VAULT_ITEMS', ?)")
        .bind(format!("Listed {} vault items", items.len()))
        .execute(&state.db)
        .await?;

    Ok(Json(items))
}

pub async fn create_vault_item(
    State(state): State<AppState>,
    session: AuthenticatedSession,
    Json(req): Json<CreateVaultItemRequest>,
) -> Result<(axum::http::StatusCode, Json<VaultItemDetail>), AppError> {
    validate_item_type(&req.item_type)?;
    validate_vault_item_payload(&req.item_type, &req.payload)?;

    let id = uuid::Uuid::new_v4().to_string();
    let payload_json = serde_json::to_string(&req.payload)
        .map_err(|e| AppError::Internal(format!("Encode vault item JSON failed: {e}")))?;
    let payload_encrypted = crypto::encrypt(&payload_json, &session.encryption_key)
        .map_err(|e| AppError::Internal(format!("Encrypt vault item failed: {e}")))?;

    sqlx::query("INSERT INTO vault_items (id, item_type, payload_encrypted) VALUES (?, ?, ?)")
        .bind(&id)
        .bind(&req.item_type)
        .bind(&payload_encrypted)
        .execute(&state.db)
        .await?;

    sqlx::query("INSERT INTO audit_log (event_type, details) VALUES ('CREATE_VAULT_ITEM', ?)")
        .bind(format!("Created {} vault item {}", req.item_type, id))
        .execute(&state.db)
        .await?;

    let row = fetch_item(&state, &id).await?;
    let item = decrypt_vault_item(row, &session.encryption_key)?;

    Ok((axum::http::StatusCode::CREATED, Json(item)))
}

pub async fn get_vault_item(
    State(state): State<AppState>,
    session: AuthenticatedSession,
    Path(id): Path<String>,
) -> Result<Json<VaultItemDetail>, AppError> {
    let row = fetch_item(&state, &id).await?;
    let item = decrypt_vault_item(row, &session.encryption_key)?;

    sqlx::query("INSERT INTO audit_log (event_type, details) VALUES ('GET_VAULT_ITEM', ?)")
        .bind(format!("Retrieved vault item {id}"))
        .execute(&state.db)
        .await?;

    Ok(Json(item))
}

pub async fn update_vault_item(
    State(state): State<AppState>,
    session: AuthenticatedSession,
    Path(id): Path<String>,
    Json(req): Json<UpdateVaultItemRequest>,
) -> Result<Json<VaultItemDetail>, AppError> {
    let existing = fetch_item(&state, &id).await?;
    validate_vault_item_payload(&existing.item_type, &req.payload)?;

    let payload_json = serde_json::to_string(&req.payload)
        .map_err(|e| AppError::Internal(format!("Encode vault item JSON failed: {e}")))?;
    let payload_encrypted = crypto::encrypt(&payload_json, &session.encryption_key)
        .map_err(|e| AppError::Internal(format!("Encrypt vault item failed: {e}")))?;

    let result = sqlx::query(
        "UPDATE vault_items SET payload_encrypted = ?, updated_at = datetime('now') WHERE id = ?",
    )
    .bind(&payload_encrypted)
    .bind(&id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Vault item not found".into()));
    }

    sqlx::query("INSERT INTO audit_log (event_type, details) VALUES ('UPDATE_VAULT_ITEM', ?)")
        .bind(format!("Updated vault item {id}"))
        .execute(&state.db)
        .await?;

    let row = fetch_item(&state, &id).await?;
    let item = decrypt_vault_item(row, &session.encryption_key)?;

    Ok(Json(item))
}

pub async fn delete_vault_item(
    State(state): State<AppState>,
    _session: AuthenticatedSession,
    Path(id): Path<String>,
) -> Result<Json<MessageResponse>, AppError> {
    let result = sqlx::query("DELETE FROM vault_items WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Vault item not found".into()));
    }

    sqlx::query("INSERT INTO audit_log (event_type, details) VALUES ('DELETE_VAULT_ITEM', ?)")
        .bind(format!("Deleted vault item {id}"))
        .execute(&state.db)
        .await?;

    Ok(Json(MessageResponse {
        message: "Vault item deleted".into(),
    }))
}

#[cfg(test)]
mod tests {
    use super::{validate_item_type, validate_vault_item_payload};
    use serde_json::json;

    #[test]
    fn accepts_supported_vault_item_types() {
        assert!(validate_item_type("card").is_ok());
        assert!(validate_item_type("address").is_ok());
        assert!(validate_item_type("passkey").is_ok());
    }

    #[test]
    fn rejects_unknown_vault_item_types() {
        assert!(validate_item_type("password").is_err());
        assert!(validate_item_type("").is_err());
    }

    #[test]
    fn validates_required_passkey_payload_fields() {
        let valid = json!({
            "rp_id": "example.com",
            "user_name": "user@example.com",
            "credential_id": "credential-id"
        });

        assert!(validate_vault_item_payload("passkey", &valid).is_ok());
        assert!(validate_vault_item_payload("passkey", &json!({})).is_err());
        assert!(validate_vault_item_payload(
            "passkey",
            &json!({
                "rp_id": "example.com",
                "user_name": "user@example.com",
                "credential_id": " "
            })
        )
        .is_err());
    }

    #[test]
    fn keeps_existing_generic_payload_behavior_for_other_vault_items() {
        assert!(validate_vault_item_payload("card", &json!({})).is_ok());
        assert!(validate_vault_item_payload("address", &json!({})).is_ok());
    }
}
