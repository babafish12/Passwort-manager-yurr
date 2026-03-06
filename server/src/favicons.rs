use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use sqlx::SqlitePool;
use std::time::Duration;
use tracing::warn;

use crate::errors::AppError;
use crate::models::FaviconRow;
use crate::session::AuthenticatedSession;
use crate::AppState;

fn build_client() -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .danger_accept_invalid_certs(true)
        .build()
}

/// Fetch a favicon for a domain. Tries Google's favicon service first,
/// then falls back to direct /favicon.ico fetch.
pub async fn fetch_favicon_for_domain(domain: &str) -> Option<(Vec<u8>, String)> {
    let client = build_client().ok()?;

    // Try Google's favicon API first
    let google_url = format!(
        "https://www.google.com/s2/favicons?domain={}&sz=32",
        domain
    );
    if let Ok(resp) = client.get(&google_url).send().await {
        if resp.status().is_success() {
            let mime = resp
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("image/png")
                .to_string();
            if let Ok(bytes) = resp.bytes().await {
                // Google returns a ~726 byte default globe icon when no favicon exists
                if bytes.len() > 1000 {
                    return Some((bytes.to_vec(), mime));
                }
            }
        }
    }

    // Fallback: direct /favicon.ico
    let direct_url = format!("https://{}/favicon.ico", domain);
    if let Ok(resp) = client.get(&direct_url).send().await {
        if resp.status().is_success() {
            let mime = resp
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("image/x-icon")
                .to_string();
            if let Ok(bytes) = resp.bytes().await {
                if !bytes.is_empty() {
                    return Some((bytes.to_vec(), mime));
                }
            }
        }
    }

    None
}

/// Check if a favicon already exists for a domain; if not, fetch and store it.
pub async fn ensure_favicon(pool: &SqlitePool, domain: &str) {
    // Check if already cached
    let exists: Option<(String,)> =
        sqlx::query_as("SELECT domain FROM favicons WHERE domain = ?")
            .bind(domain)
            .fetch_optional(pool)
            .await
            .unwrap_or(None);

    if exists.is_some() {
        return;
    }

    // Fetch and store
    match fetch_favicon_for_domain(domain).await {
        Some((image_data, mime_type)) => {
            if let Err(e) = sqlx::query(
                "INSERT OR REPLACE INTO favicons (domain, image_data, mime_type) VALUES (?, ?, ?)",
            )
            .bind(domain)
            .bind(&image_data)
            .bind(&mime_type)
            .execute(pool)
            .await
            {
                warn!("Failed to store favicon for {domain}: {e}");
            }
        }
        None => {
            warn!("No favicon found for {domain}");
        }
    }
}

/// GET /api/v1/favicons/{domain} — serve a cached favicon as raw bytes.
pub async fn get_favicon_handler(
    State(state): State<AppState>,
    _session: AuthenticatedSession,
    Path(domain): Path<String>,
) -> Result<Response, AppError> {
    let favicon: Option<FaviconRow> =
        sqlx::query_as("SELECT domain, image_data, mime_type, fetched_at FROM favicons WHERE domain = ?")
            .bind(&domain)
            .fetch_optional(&state.db)
            .await?;

    match favicon {
        Some(row) => {
            let response = (
                StatusCode::OK,
                [
                    (header::CONTENT_TYPE, row.mime_type),
                    (header::CACHE_CONTROL, "public, max-age=86400".to_string()),
                ],
                row.image_data,
            );
            Ok(response.into_response())
        }
        None => Err(AppError::NotFound("Favicon not found".into())),
    }
}
