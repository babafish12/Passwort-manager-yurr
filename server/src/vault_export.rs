use axum::extract::State;
use axum::Json;

use crate::crypto;
use crate::entries;
use crate::errors::AppError;
use crate::models::*;
use crate::session::AuthenticatedSession;
use crate::vault_items;
use crate::AppState;

const MIN_SUPPORTED_IMPORT_VERSION: u32 = 1;
const EXPORT_VERSION: u32 = 2;

fn non_empty(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn import_id(value: &str) -> String {
    non_empty(value)
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
}

fn decrypt_password_entry(
    row: EntryRow,
    encryption_key: &[u8; 32],
) -> Result<VaultExportPassword, AppError> {
    let password = crypto::decrypt(&row.password_encrypted, encryption_key)
        .map_err(|e| AppError::Internal(format!("Decrypt password failed: {e}")))?;
    let notes = row
        .notes_encrypted
        .as_deref()
        .map(|encrypted| {
            crypto::decrypt(encrypted, encryption_key)
                .map_err(|e| AppError::Internal(format!("Decrypt notes failed: {e}")))
        })
        .transpose()?;

    Ok(VaultExportPassword {
        id: row.id,
        website_url: row.website_url,
        website_domain: row.website_domain,
        username: row.username,
        password,
        notes,
        favorite: row.favorite != 0,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

pub async fn export_vault(
    State(state): State<AppState>,
    session: AuthenticatedSession,
) -> Result<Json<VaultExportDocument>, AppError> {
    let entry_rows: Vec<EntryRow> = sqlx::query_as(
        "SELECT id, website_url, website_domain, username, password_encrypted, notes_encrypted, favorite, created_at, updated_at FROM entries ORDER BY website_domain, username",
    )
    .fetch_all(&state.db)
    .await?;

    let passwords = entry_rows
        .into_iter()
        .map(|row| decrypt_password_entry(row, &session.encryption_key))
        .collect::<Result<Vec<_>, _>>()?;

    let vault_item_rows: Vec<VaultItemRow> = sqlx::query_as(
        "SELECT id, item_type, payload_encrypted, created_at, updated_at FROM vault_items ORDER BY item_type, created_at DESC",
    )
    .fetch_all(&state.db)
    .await?;

    let vault_items = vault_item_rows
        .into_iter()
        .map(|row| vault_items::decrypt_vault_item(row, &session.encryption_key))
        .collect::<Result<Vec<_>, _>>()?;

    sqlx::query("INSERT INTO audit_log (event_type, details) VALUES ('VAULT_EXPORT', ?)")
        .bind(format!(
            "Exported {} passwords and {} vault items",
            passwords.len(),
            vault_items.len()
        ))
        .execute(&state.db)
        .await?;

    Ok(Json(VaultExportDocument {
        version: EXPORT_VERSION,
        exported_at: chrono::Utc::now().to_rfc3339(),
        passwords,
        vault_items,
    }))
}

pub async fn import_vault(
    State(state): State<AppState>,
    session: AuthenticatedSession,
    Json(req): Json<VaultExportDocument>,
) -> Result<Json<VaultImportResponse>, AppError> {
    if req.version < MIN_SUPPORTED_IMPORT_VERSION || req.version > EXPORT_VERSION {
        return Err(AppError::BadRequest(format!(
            "Unsupported vault export version {}",
            req.version
        )));
    }

    let mut result = VaultImportResponse {
        imported_passwords: 0,
        imported_vault_items: 0,
        skipped_passwords: 0,
        skipped_vault_items: 0,
        failed: 0,
        errors: Vec::new(),
    };

    let mut conn = state.db.acquire().await?;
    sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;
    let mut favicon_domains = Vec::new();

    for password in req.passwords {
        let id = import_id(&password.id);
        let entry = match entries::validate_create_entry(&CreateEntryRequest {
            website_url: password.website_url.clone(),
            username: password.username.clone(),
            password: password.password.clone(),
            notes: password.notes.clone(),
        }) {
            Ok(entry) => entry,
            Err(err) => {
                result.failed += 1;
                result
                    .errors
                    .push(format!("{}: invalid password entry: {err}", password.id));
                continue;
            }
        };

        let existing_id: Option<(String,)> =
            match sqlx::query_as("SELECT id FROM entries WHERE id = ?")
                .bind(&id)
                .fetch_optional(&mut *conn)
                .await
            {
                Ok(existing) => existing,
                Err(err) => {
                    result.failed += 1;
                    result
                        .errors
                        .push(format!("{}: duplicate id check failed: {err}", password.id));
                    continue;
                }
            };
        if existing_id.is_some() {
            result.skipped_passwords += 1;
            continue;
        }

        match entries::duplicate_entry_exists(
            &mut *conn,
            &entry.website_domain,
            &entry.username,
            None,
        )
        .await
        {
            Ok(true) => {
                result.skipped_passwords += 1;
                continue;
            }
            Ok(false) => {}
            Err(err) => {
                result.failed += 1;
                result
                    .errors
                    .push(format!("{}: duplicate check failed: {err}", password.id));
                continue;
            }
        }

        let password_encrypted = match crypto::encrypt(&entry.password, &session.encryption_key) {
            Ok(encrypted) => encrypted,
            Err(err) => {
                result.failed += 1;
                result
                    .errors
                    .push(format!("{}: encrypt password failed: {err}", password.id));
                continue;
            }
        };

        let notes_encrypted = if let Some(notes) = entry.notes.as_deref() {
            if notes.is_empty() {
                None
            } else {
                match crypto::encrypt(notes, &session.encryption_key) {
                    Ok(encrypted) => Some(encrypted),
                    Err(err) => {
                        result.failed += 1;
                        result
                            .errors
                            .push(format!("{}: encrypt notes failed: {err}", password.id));
                        continue;
                    }
                }
            }
        } else {
            None
        };

        match sqlx::query(
            "INSERT INTO entries (id, website_url, website_domain, username, password_encrypted, notes_encrypted, favorite, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))",
        )
        .bind(&id)
        .bind(&entry.website_url)
        .bind(&entry.website_domain)
        .bind(&entry.username)
        .bind(&password_encrypted)
        .bind(&notes_encrypted)
        .bind(if password.favorite { 1_i64 } else { 0_i64 })
        .bind(non_empty(&password.created_at))
        .bind(non_empty(&password.updated_at))
        .execute(&mut *conn)
        .await
        {
            Ok(_) => {
                result.imported_passwords += 1;
                favicon_domains.push(entry.website_domain);
            }
            Err(err) => {
                result.failed += 1;
                result
                    .errors
                    .push(format!("{}: insert password failed: {err}", password.id));
            }
        }
    }

    if let Err(err) = sqlx::query("COMMIT").execute(&mut *conn).await {
        let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
        return Err(err.into());
    }

    for domain in favicon_domains {
        let pool = state.db.clone();
        tokio::spawn(async move {
            crate::favicons::ensure_favicon(&pool, &domain).await;
        });
    }

    for item in req.vault_items {
        if let Err(err) = vault_items::validate_item_type(&item.item_type) {
            result.failed += 1;
            result.errors.push(format!("{}: {err}", item.id));
            continue;
        }
        if let Err(err) = vault_items::validate_vault_item_payload(&item.item_type, &item.payload) {
            result.failed += 1;
            result.errors.push(format!("{}: {err}", item.id));
            continue;
        }

        let id = import_id(&item.id);
        let payload_json = match serde_json::to_string(&item.payload) {
            Ok(payload_json) => payload_json,
            Err(err) => {
                result.failed += 1;
                result
                    .errors
                    .push(format!("{}: encode vault item failed: {err}", item.id));
                continue;
            }
        };
        let payload_encrypted = match crypto::encrypt(&payload_json, &session.encryption_key) {
            Ok(encrypted) => encrypted,
            Err(err) => {
                result.failed += 1;
                result
                    .errors
                    .push(format!("{}: encrypt vault item failed: {err}", item.id));
                continue;
            }
        };

        match sqlx::query(
            "INSERT OR IGNORE INTO vault_items (id, item_type, payload_encrypted, created_at, updated_at) VALUES (?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))",
        )
        .bind(&id)
        .bind(&item.item_type)
        .bind(&payload_encrypted)
        .bind(non_empty(&item.created_at))
        .bind(non_empty(&item.updated_at))
        .execute(&state.db)
        .await
        {
            Ok(done) if done.rows_affected() == 0 => result.skipped_vault_items += 1,
            Ok(_) => result.imported_vault_items += 1,
            Err(err) => {
                result.failed += 1;
                result
                    .errors
                    .push(format!("{}: insert vault item failed: {err}", item.id));
            }
        }
    }

    sqlx::query("INSERT INTO audit_log (event_type, details) VALUES ('VAULT_IMPORT', ?)")
        .bind(format!(
            "Imported {} passwords and {} vault items; skipped {} passwords and {} vault items; failed {}",
            result.imported_passwords,
            result.imported_vault_items,
            result.skipped_passwords,
            result.skipped_vault_items,
            result.failed
        ))
        .execute(&state.db)
        .await?;

    Ok(Json(result))
}
