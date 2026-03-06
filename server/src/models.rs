use serde::{Deserialize, Serialize};

// --- Database row types ---

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct MasterConfigRow {
    pub id: i64,
    pub password_hash: String,
    pub encryption_salt: String,
    pub argon2_m_cost: i64,
    pub argon2_t_cost: i64,
    pub argon2_p_cost: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct EntryRow {
    pub id: String,
    pub website_url: String,
    pub website_domain: String,
    pub username: String,
    pub password_encrypted: String,
    pub notes_encrypted: Option<String>,
    pub favorite: i64,
    pub created_at: String,
    pub updated_at: String,
}

// --- Request types ---

#[derive(Debug, Deserialize)]
pub struct SetupRequest {
    pub master_password: String,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub master_password: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateEntryRequest {
    pub website_url: String,
    pub username: String,
    pub password: String,
    pub notes: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateEntryRequest {
    pub website_url: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct GeneratePasswordRequest {
    pub length: Option<usize>,
    pub uppercase: Option<bool>,
    pub lowercase: Option<bool>,
    pub digits: Option<bool>,
    pub symbols: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct ChangePasswordRequest {
    pub current_password: String,
    pub new_password: String,
}

// --- Database row types (favicons) ---

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct FaviconRow {
    pub domain: String,
    pub image_data: Vec<u8>,
    pub mime_type: String,
    pub fetched_at: String,
}

// --- Response types ---

#[derive(Debug, Serialize)]
pub struct AuthStatusResponse {
    pub initialized: bool,
    pub server_version: String,
}

#[derive(Debug, Serialize)]
pub struct LoginResponse {
    pub token: String,
}

#[derive(Debug, Serialize)]
pub struct EntryListItem {
    pub id: String,
    pub website_url: String,
    pub website_domain: String,
    pub username: String,
    pub favorite: bool,
    pub has_favicon: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
pub struct EntryDetail {
    pub id: String,
    pub website_url: String,
    pub website_domain: String,
    pub username: String,
    pub password: String,
    pub notes: Option<String>,
    pub favorite: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
pub struct GeneratePasswordResponse {
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct MessageResponse {
    pub message: String,
}

impl From<&EntryRow> for EntryListItem {
    fn from(row: &EntryRow) -> Self {
        EntryListItem {
            id: row.id.clone(),
            website_url: row.website_url.clone(),
            website_domain: row.website_domain.clone(),
            username: row.username.clone(),
            favorite: row.favorite != 0,
            has_favicon: false,
            created_at: row.created_at.clone(),
            updated_at: row.updated_at.clone(),
        }
    }
}

// --- Bulk import types ---

#[derive(Debug, Deserialize)]
pub struct BulkImportRequest {
    pub entries: Vec<CreateEntryRequest>,
    pub skip_duplicates: bool,
}

#[derive(Debug, Serialize)]
pub struct BulkImportResponse {
    pub imported: usize,
    pub skipped: usize,
    pub failed: usize,
    pub errors: Vec<String>,
}
