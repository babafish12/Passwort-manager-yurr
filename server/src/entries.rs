use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;

use std::collections::HashSet;

use crate::crypto;
use crate::errors::AppError;
use crate::favicons;
use crate::models::*;
use crate::session::AuthenticatedSession;
use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub domain: Option<String>,
}

fn extract_domain(url_str: &str) -> String {
    url::Url::parse(url_str)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .unwrap_or_else(|| url_str.to_string())
}

pub async fn list_entries(
    State(state): State<AppState>,
    _session: AuthenticatedSession,
    Query(query): Query<ListQuery>,
) -> Result<Json<Vec<EntryListItem>>, AppError> {
    let entries: Vec<EntryRow> = if let Some(domain) = &query.domain {
        sqlx::query_as(
            "SELECT id, website_url, website_domain, username, password_encrypted, notes_encrypted, favorite, created_at, updated_at FROM entries WHERE website_domain = ? ORDER BY website_domain, username",
        )
        .bind(domain)
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query_as(
            "SELECT id, website_url, website_domain, username, password_encrypted, notes_encrypted, favorite, created_at, updated_at FROM entries ORDER BY website_domain, username",
        )
        .fetch_all(&state.db)
        .await?
    };

    let favicon_domains: Vec<(String,)> =
        sqlx::query_as("SELECT domain FROM favicons")
            .fetch_all(&state.db)
            .await?;
    let favicon_set: HashSet<String> = favicon_domains.into_iter().map(|r| r.0).collect();

    let items: Vec<EntryListItem> = entries
        .iter()
        .map(|row| {
            let mut item = EntryListItem::from(row);
            item.has_favicon = favicon_set.contains(&row.website_domain);
            item
        })
        .collect();

    sqlx::query("INSERT INTO audit_log (event_type, details) VALUES ('LIST_ENTRIES', ?)")
        .bind(format!("Listed {} entries", items.len()))
        .execute(&state.db)
        .await?;

    Ok(Json(items))
}

pub async fn get_entry(
    State(state): State<AppState>,
    session: AuthenticatedSession,
    Path(id): Path<String>,
) -> Result<Json<EntryDetail>, AppError> {
    let entry: EntryRow = sqlx::query_as(
        "SELECT id, website_url, website_domain, username, password_encrypted, notes_encrypted, favorite, created_at, updated_at FROM entries WHERE id = ?",
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Entry not found".into()))?;

    let password = crypto::decrypt(&entry.password_encrypted, &session.encryption_key)
        .map_err(|e| AppError::Internal(format!("Decrypt failed: {e}")))?;

    let notes = if let Some(ref notes_enc) = entry.notes_encrypted {
        Some(
            crypto::decrypt(notes_enc, &session.encryption_key)
                .map_err(|e| AppError::Internal(format!("Decrypt notes failed: {e}")))?,
        )
    } else {
        None
    };

    sqlx::query("INSERT INTO audit_log (event_type, details) VALUES ('GET_ENTRY', ?)")
        .bind(format!("Retrieved entry {}", id))
        .execute(&state.db)
        .await?;

    Ok(Json(EntryDetail {
        id: entry.id,
        website_url: entry.website_url,
        website_domain: entry.website_domain,
        username: entry.username,
        password,
        notes,
        favorite: entry.favorite != 0,
        created_at: entry.created_at,
        updated_at: entry.updated_at,
    }))
}

pub async fn create_entry(
    State(state): State<AppState>,
    session: AuthenticatedSession,
    Json(req): Json<CreateEntryRequest>,
) -> Result<(axum::http::StatusCode, Json<EntryListItem>), AppError> {
    let id = uuid::Uuid::new_v4().to_string();
    let domain = extract_domain(&req.website_url);

    let password_encrypted = crypto::encrypt(&req.password, &session.encryption_key)
        .map_err(|e| AppError::Internal(format!("Encrypt failed: {e}")))?;

    let notes_encrypted = if let Some(ref notes) = req.notes {
        if !notes.is_empty() {
            Some(
                crypto::encrypt(notes, &session.encryption_key)
                    .map_err(|e| AppError::Internal(format!("Encrypt notes failed: {e}")))?,
            )
        } else {
            None
        }
    } else {
        None
    };

    sqlx::query(
        "INSERT INTO entries (id, website_url, website_domain, username, password_encrypted, notes_encrypted) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&req.website_url)
    .bind(&domain)
    .bind(&req.username)
    .bind(&password_encrypted)
    .bind(&notes_encrypted)
    .execute(&state.db)
    .await?;

    sqlx::query("INSERT INTO audit_log (event_type, details) VALUES ('CREATE_ENTRY', ?)")
        .bind(format!("Created entry for {domain}"))
        .execute(&state.db)
        .await?;

    // Fetch favicon in the background
    let pool = state.db.clone();
    let domain_clone = domain.clone();
    tokio::spawn(async move {
        favicons::ensure_favicon(&pool, &domain_clone).await;
    });

    Ok((
        axum::http::StatusCode::CREATED,
        Json(EntryListItem {
            id,
            website_url: req.website_url,
            website_domain: domain,
            username: req.username,
            favorite: false,
            has_favicon: false,
            created_at: chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            updated_at: chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        }),
    ))
}

pub async fn update_entry(
    State(state): State<AppState>,
    session: AuthenticatedSession,
    Path(id): Path<String>,
    Json(req): Json<UpdateEntryRequest>,
) -> Result<Json<MessageResponse>, AppError> {
    // Check entry exists
    let entry: EntryRow = sqlx::query_as(
        "SELECT id, website_url, website_domain, username, password_encrypted, notes_encrypted, favorite, created_at, updated_at FROM entries WHERE id = ?",
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Entry not found".into()))?;

    let website_url = req.website_url.unwrap_or(entry.website_url);
    let domain = extract_domain(&website_url);
    let username = req.username.unwrap_or(entry.username);

    let password_encrypted = if let Some(ref new_pw) = req.password {
        crypto::encrypt(new_pw, &session.encryption_key)
            .map_err(|e| AppError::Internal(format!("Encrypt failed: {e}")))?
    } else {
        entry.password_encrypted
    };

    let notes_encrypted = if let Some(ref notes) = req.notes {
        if !notes.is_empty() {
            Some(
                crypto::encrypt(notes, &session.encryption_key)
                    .map_err(|e| AppError::Internal(format!("Encrypt notes failed: {e}")))?,
            )
        } else {
            None
        }
    } else {
        entry.notes_encrypted
    };

    sqlx::query(
        "UPDATE entries SET website_url = ?, website_domain = ?, username = ?, password_encrypted = ?, notes_encrypted = ?, updated_at = datetime('now') WHERE id = ?",
    )
    .bind(&website_url)
    .bind(&domain)
    .bind(&username)
    .bind(&password_encrypted)
    .bind(&notes_encrypted)
    .bind(&id)
    .execute(&state.db)
    .await?;

    sqlx::query("INSERT INTO audit_log (event_type, details) VALUES ('UPDATE_ENTRY', ?)")
        .bind(format!("Updated entry {id}"))
        .execute(&state.db)
        .await?;

    // Fetch favicon in the background if domain changed
    if domain != entry.website_domain {
        let pool = state.db.clone();
        let domain_clone = domain.clone();
        tokio::spawn(async move {
            favicons::ensure_favicon(&pool, &domain_clone).await;
        });
    }

    Ok(Json(MessageResponse {
        message: "Entry updated".into(),
    }))
}

pub async fn delete_entry(
    State(state): State<AppState>,
    _session: AuthenticatedSession,
    Path(id): Path<String>,
) -> Result<Json<MessageResponse>, AppError> {
    let result = sqlx::query("DELETE FROM entries WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Entry not found".into()));
    }

    sqlx::query("INSERT INTO audit_log (event_type, details) VALUES ('DELETE_ENTRY', ?)")
        .bind(format!("Deleted entry {id}"))
        .execute(&state.db)
        .await?;

    Ok(Json(MessageResponse {
        message: "Entry deleted".into(),
    }))
}

pub async fn bulk_import(
    State(state): State<AppState>,
    session: AuthenticatedSession,
    Json(req): Json<BulkImportRequest>,
) -> Result<Json<BulkImportResponse>, AppError> {
    let mut imported = 0usize;
    let mut skipped = 0usize;
    let mut failed = 0usize;
    let mut errors = Vec::new();

    // Build set of existing (domain, username) pairs for duplicate detection
    let existing: Vec<EntryRow> = sqlx::query_as(
        "SELECT id, website_url, website_domain, username, password_encrypted, notes_encrypted, favorite, created_at, updated_at FROM entries",
    )
    .fetch_all(&state.db)
    .await?;

    let existing_set: HashSet<(String, String)> = existing
        .iter()
        .map(|e| (e.website_domain.clone(), e.username.clone()))
        .collect();

    for entry_req in &req.entries {
        let domain = extract_domain(&entry_req.website_url);

        if req.skip_duplicates && existing_set.contains(&(domain.clone(), entry_req.username.clone())) {
            skipped += 1;
            continue;
        }

        let id = uuid::Uuid::new_v4().to_string();

        let password_encrypted = match crypto::encrypt(&entry_req.password, &session.encryption_key) {
            Ok(enc) => enc,
            Err(e) => {
                failed += 1;
                errors.push(format!("{domain}: encrypt failed: {e}"));
                continue;
            }
        };

        let notes_encrypted = if let Some(ref notes) = entry_req.notes {
            if !notes.is_empty() {
                crypto::encrypt(notes, &session.encryption_key).ok()
            } else {
                None
            }
        } else {
            None
        };

        match sqlx::query(
            "INSERT INTO entries (id, website_url, website_domain, username, password_encrypted, notes_encrypted) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&entry_req.website_url)
        .bind(&domain)
        .bind(&entry_req.username)
        .bind(&password_encrypted)
        .bind(&notes_encrypted)
        .execute(&state.db)
        .await
        {
            Ok(_) => {
                imported += 1;
                let pool = state.db.clone();
                let d = domain.clone();
                tokio::spawn(async move {
                    favicons::ensure_favicon(&pool, &d).await;
                });
            }
            Err(e) => {
                failed += 1;
                errors.push(format!("{domain}: db insert failed: {e}"));
            }
        }
    }

    sqlx::query("INSERT INTO audit_log (event_type, details) VALUES ('BULK_IMPORT', ?)")
        .bind(format!("Imported {imported}, skipped {skipped}, failed {failed}"))
        .execute(&state.db)
        .await?;

    Ok(Json(BulkImportResponse {
        imported,
        skipped,
        failed,
        errors,
    }))
}
