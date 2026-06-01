use serde::{Deserialize, Serialize};
use serde_json::Value;

// --- Database row types ---

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct MasterConfigRow {
    pub password_hash: String,
    pub encryption_salt: String,
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

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct VaultItemRow {
    pub id: String,
    pub item_type: String,
    pub payload_encrypted: String,
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
    pub never_auto_lock: Option<bool>,
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

#[derive(Debug, Deserialize)]
pub struct CreateVaultItemRequest {
    pub item_type: String,
    pub payload: Value,
}

#[derive(Debug, Deserialize)]
pub struct UpdateVaultItemRequest {
    pub payload: Value,
}

// --- Database row types (favicons) ---

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct FaviconRow {
    pub image_data: Vec<u8>,
    pub mime_type: String,
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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VaultItemDetail {
    pub id: String,
    pub item_type: String,
    pub payload: Value,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VaultExportPassword {
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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VaultExportDocument {
    pub version: u32,
    pub exported_at: String,
    pub passwords: Vec<VaultExportPassword>,
    pub vault_items: Vec<VaultItemDetail>,
}

#[derive(Debug, Deserialize)]
pub struct VaultExportRequest {
    pub master_password: String,
}

#[derive(Debug, Serialize)]
pub struct VaultImportResponse {
    pub imported_passwords: usize,
    pub imported_vault_items: usize,
    pub skipped_passwords: usize,
    pub skipped_vault_items: usize,
    pub failed: usize,
    pub errors: Vec<String>,
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
