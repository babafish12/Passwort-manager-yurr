use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use sqlx::SqliteConnection;

use std::collections::HashSet;

use crate::crypto;
use crate::domain;
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
    domain::normalize_domain_lossy(url_str)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ValidatedEntryInput {
    pub(crate) website_url: String,
    pub(crate) website_domain: String,
    pub(crate) username: String,
    pub(crate) password: String,
    pub(crate) notes: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ValidatedEntryUpdate {
    website_url: String,
    website_domain: String,
    username: String,
}

fn validate_website_url(raw: &str) -> Result<(String, String), AppError> {
    let website_url = raw.trim().to_string();
    let website_domain = domain::normalize_entry_domain(&website_url).ok_or_else(|| {
        AppError::BadRequest("Website must be a valid http(s) URL or domain".into())
    })?;

    Ok((website_url, website_domain))
}

fn validate_username(raw: &str) -> Result<String, AppError> {
    let username = raw.trim();
    if username.is_empty() {
        return Err(AppError::BadRequest("Username is required".into()));
    }

    Ok(username.to_string())
}

fn validate_password(raw: &str) -> Result<(), AppError> {
    if raw.trim().is_empty() {
        return Err(AppError::BadRequest("Password is required".into()));
    }

    Ok(())
}

fn normalize_notes(notes: Option<&str>) -> Option<String> {
    notes
        .filter(|value| !value.is_empty())
        .map(std::string::ToString::to_string)
}

pub(crate) fn validate_create_entry(
    req: &CreateEntryRequest,
) -> Result<ValidatedEntryInput, AppError> {
    let (website_url, website_domain) = validate_website_url(&req.website_url)?;
    let username = validate_username(&req.username)?;
    validate_password(&req.password)?;

    Ok(ValidatedEntryInput {
        website_url,
        website_domain,
        username,
        password: req.password.clone(),
        notes: normalize_notes(req.notes.as_deref()),
    })
}

fn validate_update_entry(
    existing: &EntryRow,
    req: &UpdateEntryRequest,
) -> Result<ValidatedEntryUpdate, AppError> {
    let raw_website_url = req.website_url.as_deref().unwrap_or(&existing.website_url);
    let raw_username = req.username.as_deref().unwrap_or(&existing.username);

    let (website_url, website_domain) = validate_website_url(raw_website_url)?;
    let username = validate_username(raw_username)?;
    if let Some(password) = req.password.as_deref() {
        validate_password(password)?;
    }

    Ok(ValidatedEntryUpdate {
        website_url,
        website_domain,
        username,
    })
}

fn encrypt_optional_notes(notes: Option<&str>, key: &[u8; 32]) -> Result<Option<String>, String> {
    match notes {
        Some(notes) if !notes.is_empty() => crypto::encrypt(notes, key).map(Some),
        _ => Ok(None),
    }
}

pub(crate) async fn duplicate_entry_exists(
    conn: &mut SqliteConnection,
    website_url: &str,
    username: &str,
    excluded_id: Option<&str>,
) -> Result<bool, sqlx::Error> {
    let website_domain = extract_domain(website_url);
    let scope = domain::credential_scope(website_url);
    let candidates: Vec<(String,)> = sqlx::query_as(
        "SELECT website_url FROM entries WHERE website_domain = ? AND username = ? AND (? IS NULL OR id <> ?)",
    )
    .bind(&website_domain)
    .bind(username)
    .bind(excluded_id)
    .bind(excluded_id)
    .fetch_all(&mut *conn)
    .await?;

    Ok(scope.is_some()
        && candidates
            .iter()
            .any(|(url,)| domain::credential_scope(url) == scope))
}

async fn insert_entry_row(
    conn: &mut SqliteConnection,
    id: &str,
    entry: &ValidatedEntryInput,
    password_encrypted: &str,
    notes_encrypted: &Option<String>,
) -> Result<(), AppError> {
    if duplicate_entry_exists(conn, &entry.website_url, &entry.username, None).await? {
        return Err(AppError::Conflict(
            "Entry already exists for this website and username".into(),
        ));
    }

    sqlx::query(
        "INSERT INTO entries (id, website_url, website_domain, username, password_encrypted, notes_encrypted) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(&entry.website_url)
    .bind(&entry.website_domain)
    .bind(&entry.username)
    .bind(password_encrypted)
    .bind(notes_encrypted)
    .execute(&mut *conn)
    .await?;

    Ok(())
}

pub async fn list_entries(
    State(state): State<AppState>,
    _session: AuthenticatedSession,
    Query(query): Query<ListQuery>,
) -> Result<Json<Vec<EntryListItem>>, AppError> {
    let query_domain = query.domain.as_deref().map(extract_domain);
    let query_scope = query.domain.as_deref().and_then(domain::credential_scope);
    let entries: Vec<EntryRow> = if let Some(domain) = &query_domain {
        sqlx::query_as(
            "SELECT id, website_url, website_domain, username, password_encrypted, notes_encrypted, favorite, created_at, updated_at FROM entries WHERE website_domain IN (?, ?, ?) ORDER BY website_domain, username",
        )
        .bind(domain)
        .bind(domain.strip_prefix("www.").unwrap_or(domain))
        .bind(format!("www.{}", domain.strip_prefix("www.").unwrap_or(domain)))
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query_as(
            "SELECT id, website_url, website_domain, username, password_encrypted, notes_encrypted, favorite, created_at, updated_at FROM entries ORDER BY website_domain, username",
        )
        .fetch_all(&state.db)
        .await?
    };

    let favicon_domains: Vec<(String,)> = sqlx::query_as("SELECT domain FROM favicons")
        .fetch_all(&state.db)
        .await?;
    let favicon_set: HashSet<String> = favicon_domains
        .into_iter()
        .map(|row| extract_domain(&row.0))
        .collect();

    let items: Vec<EntryListItem> = entries
        .iter()
        .filter(|row| {
            !query_domain.as_deref().is_some_and(domain::is_local_host)
                || domain::credential_scope(&row.website_url) == query_scope
        })
        .map(|row| {
            let mut item = EntryListItem::from(row);
            item.has_favicon = favicon_set.contains(&extract_domain(&row.website_domain));
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

    let has_favicon =
        sqlx::query_scalar::<_, i64>("SELECT EXISTS(SELECT 1 FROM favicons WHERE domain = ?)")
            .bind(&entry.website_domain)
            .fetch_one(&state.db)
            .await?
            != 0;

    Ok(Json(EntryDetail {
        id: entry.id,
        website_url: entry.website_url,
        website_domain: entry.website_domain,
        username: entry.username,
        password,
        notes,
        favorite: entry.favorite != 0,
        has_favicon,
        created_at: entry.created_at,
        updated_at: entry.updated_at,
    }))
}

pub async fn create_entry(
    State(state): State<AppState>,
    session: AuthenticatedSession,
    Json(req): Json<CreateEntryRequest>,
) -> Result<(axum::http::StatusCode, Json<EntryListItem>), AppError> {
    let entry = validate_create_entry(&req)?;
    let id = uuid::Uuid::new_v4().to_string();

    let password_encrypted = crypto::encrypt(&entry.password, &session.encryption_key)
        .map_err(|e| AppError::Internal(format!("Encrypt failed: {e}")))?;

    let notes_encrypted = encrypt_optional_notes(entry.notes.as_deref(), &session.encryption_key)
        .map_err(|e| AppError::Internal(format!("Encrypt notes failed: {e}")))?;

    let mut conn = state.db.begin_with("BEGIN IMMEDIATE").await?;

    let insert_result = insert_entry_row(
        &mut conn,
        &id,
        &entry,
        &password_encrypted,
        &notes_encrypted,
    )
    .await;

    insert_result?;
    conn.commit().await?;

    sqlx::query("INSERT INTO audit_log (event_type, details) VALUES ('CREATE_ENTRY', ?)")
        .bind(format!("Created entry for {}", entry.website_domain))
        .execute(&state.db)
        .await?;

    // Fetch favicon in the background
    let pool = state.db.clone();
    let domain_clone = entry.website_domain.clone();
    tokio::spawn(async move {
        favicons::ensure_favicon(&pool, &domain_clone).await;
    });

    Ok((
        axum::http::StatusCode::CREATED,
        Json(EntryListItem {
            id,
            website_url: entry.website_url,
            website_domain: entry.website_domain,
            username: entry.username,
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
    let mut conn = state.db.begin_with("BEGIN IMMEDIATE").await?;

    let update_result: Result<(String, String), AppError> = async {
        let entry: EntryRow = sqlx::query_as(
            "SELECT id, website_url, website_domain, username, password_encrypted, notes_encrypted, favorite, created_at, updated_at FROM entries WHERE id = ?",
        )
        .bind(&id)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(|| AppError::NotFound("Entry not found".into()))?;

        let old_domain = entry.website_domain.clone();
        let validated = validate_update_entry(&entry, &req)?;

        if duplicate_entry_exists(
            &mut conn,
            &validated.website_url,
            &validated.username,
            Some(&id),
        )
        .await?
        {
            return Err(AppError::Conflict(
                "Entry already exists for this website and username".into(),
            ));
        }

        let password_encrypted = if let Some(ref new_pw) = req.password {
            crypto::encrypt(new_pw, &session.encryption_key)
                .map_err(|e| AppError::Internal(format!("Encrypt failed: {e}")))?
        } else {
            entry.password_encrypted
        };

        let notes_encrypted = if let Some(ref notes) = req.notes {
            encrypt_optional_notes(Some(notes.as_str()), &session.encryption_key)
                .map_err(|e| AppError::Internal(format!("Encrypt notes failed: {e}")))?
        } else {
            entry.notes_encrypted
        };

        sqlx::query(
            "UPDATE entries SET website_url = ?, website_domain = ?, username = ?, password_encrypted = ?, notes_encrypted = ?, updated_at = datetime('now') WHERE id = ?",
        )
        .bind(&validated.website_url)
        .bind(&validated.website_domain)
        .bind(&validated.username)
        .bind(&password_encrypted)
        .bind(&notes_encrypted)
        .bind(&id)
        .execute(&mut *conn)
        .await?;

        Ok((validated.website_domain, old_domain))
    }
    .await;

    let (domain, old_domain) = update_result?;
    conn.commit().await?;

    sqlx::query("INSERT INTO audit_log (event_type, details) VALUES ('UPDATE_ENTRY', ?)")
        .bind(format!("Updated entry {id}"))
        .execute(&state.db)
        .await?;

    // Fetch favicon in the background if domain changed
    if domain != old_domain {
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

    let mut favicon_domains = HashSet::new();
    let mut conn = state.db.begin_with("BEGIN IMMEDIATE").await?;

    for entry_req in &req.entries {
        let id = uuid::Uuid::new_v4().to_string();
        let entry = match validate_create_entry(entry_req) {
            Ok(entry) => entry,
            Err(err) => {
                failed += 1;
                errors.push(format!("entry {id}: validation failed: {err}"));
                continue;
            }
        };

        let password_encrypted = match crypto::encrypt(&entry.password, &session.encryption_key) {
            Ok(enc) => enc,
            Err(e) => {
                failed += 1;
                errors.push(format!("{}: encrypt failed: {e}", entry.website_domain));
                continue;
            }
        };

        let notes_encrypted =
            match encrypt_optional_notes(entry.notes.as_deref(), &session.encryption_key) {
                Ok(notes) => notes,
                Err(e) => {
                    failed += 1;
                    errors.push(format!(
                        "{}: encrypt notes failed: {e}",
                        entry.website_domain
                    ));
                    continue;
                }
            };

        match insert_entry_row(
            &mut conn,
            &id,
            &entry,
            &password_encrypted,
            &notes_encrypted,
        )
        .await
        {
            Ok(()) => {
                imported += 1;
                favicon_domains.insert(entry.website_domain.clone());
            }
            Err(AppError::Conflict(err)) if req.skip_duplicates => {
                let _ = err;
                skipped += 1;
            }
            Err(AppError::Conflict(err)) => {
                failed += 1;
                errors.push(format!("{}: {err}", entry.website_domain));
            }
            Err(e) => {
                failed += 1;
                errors.push(format!("{}: db insert failed: {e}", entry.website_domain));
            }
        }
    }

    conn.commit().await?;

    for domain in favicon_domains {
        let pool = state.db.clone();
        tokio::spawn(async move {
            favicons::ensure_favicon(&pool, &domain).await;
        });
    }

    sqlx::query("INSERT INTO audit_log (event_type, details) VALUES ('BULK_IMPORT', ?)")
        .bind(format!(
            "Imported {imported}, skipped {skipped}, failed {failed}"
        ))
        .execute(&state.db)
        .await?;

    Ok(Json(BulkImportResponse {
        imported,
        skipped,
        failed,
        errors,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqlitePool, SqlitePoolOptions};

    fn create_request(website_url: &str, username: &str, password: &str) -> CreateEntryRequest {
        CreateEntryRequest {
            website_url: website_url.to_string(),
            username: username.to_string(),
            password: password.to_string(),
            notes: None,
        }
    }

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("in-memory sqlite should connect");

        sqlx::query(
            "CREATE TABLE entries (
                id                  TEXT PRIMARY KEY,
                website_url         TEXT NOT NULL,
                website_domain      TEXT NOT NULL,
                username            TEXT NOT NULL,
                password_encrypted  TEXT NOT NULL,
                notes_encrypted     TEXT,
                favorite            INTEGER NOT NULL DEFAULT 0,
                created_at          TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
            )",
        )
        .execute(&pool)
        .await
        .expect("entries table should be created");

        pool
    }

    #[test]
    fn validate_create_entry_accepts_http_https_and_bare_domains() {
        let https = validate_create_entry(&create_request(
            " https://WWW.Example.COM/login ",
            " alice ",
            "secret",
        ))
        .expect("https URL should validate");
        assert_eq!(https.website_url, "https://WWW.Example.COM/login");
        assert_eq!(https.website_domain, "www.example.com");
        assert_eq!(https.username, "alice");

        let bare = validate_create_entry(&create_request("example.org/path", "bob", "secret"))
            .expect("bare domain should validate");
        assert_eq!(bare.website_domain, "example.org");
    }

    #[test]
    fn validate_create_entry_rejects_empty_required_fields() {
        assert!(matches!(
            validate_create_entry(&create_request("", "alice", "secret")),
            Err(AppError::BadRequest(_))
        ));
        assert!(matches!(
            validate_create_entry(&create_request("example.com", "   ", "secret")),
            Err(AppError::BadRequest(_))
        ));
        assert!(matches!(
            validate_create_entry(&create_request("example.com", "alice", "   ")),
            Err(AppError::BadRequest(_))
        ));
    }

    #[test]
    fn validate_create_entry_rejects_invalid_or_unsupported_urls() {
        assert!(matches!(
            validate_create_entry(&create_request("not a url", "alice", "secret")),
            Err(AppError::BadRequest(_))
        ));
        assert!(matches!(
            validate_create_entry(&create_request("ftp://example.com", "alice", "secret")),
            Err(AppError::BadRequest(_))
        ));
        assert!(matches!(
            validate_create_entry(&create_request(
                "https://user:pass@example.com",
                "alice",
                "secret"
            )),
            Err(AppError::BadRequest(_))
        ));
    }

    #[tokio::test]
    async fn insert_entry_row_rejects_duplicate_domain_username() {
        let pool = test_pool().await;
        let mut conn = pool.acquire().await.expect("connection should be acquired");
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *conn)
            .await
            .expect("transaction should begin");

        let entry = validate_create_entry(&create_request("https://example.com", "alice", "pw"))
            .expect("entry should validate");
        insert_entry_row(&mut conn, "one", &entry, "encrypted", &None)
            .await
            .expect("first insert should succeed");

        let duplicate = insert_entry_row(&mut conn, "two", &entry, "encrypted", &None).await;
        assert!(matches!(duplicate, Err(AppError::Conflict(_))));

        sqlx::query("ROLLBACK")
            .execute(&mut *conn)
            .await
            .expect("transaction should roll back");
    }

    #[tokio::test]
    async fn duplicate_entry_exists_honors_update_exclusion() {
        let pool = test_pool().await;
        let mut conn = pool.acquire().await.expect("connection should be acquired");
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *conn)
            .await
            .expect("transaction should begin");

        let alice = validate_create_entry(&create_request("example.com", "alice", "pw"))
            .expect("entry should validate");
        let bob = validate_create_entry(&create_request("example.com", "bob", "pw"))
            .expect("entry should validate");

        insert_entry_row(&mut conn, "alice-id", &alice, "encrypted", &None)
            .await
            .expect("first insert should succeed");
        insert_entry_row(&mut conn, "bob-id", &bob, "encrypted", &None)
            .await
            .expect("second insert should succeed");

        assert!(
            !duplicate_entry_exists(&mut conn, "example.com", "alice", Some("alice-id"))
                .await
                .expect("duplicate query should succeed")
        );
        assert!(
            duplicate_entry_exists(&mut conn, "example.com", "alice", Some("bob-id"))
                .await
                .expect("duplicate query should succeed")
        );

        sqlx::query("ROLLBACK")
            .execute(&mut *conn)
            .await
            .expect("transaction should roll back");
    }
}
