use sqlx::sqlite::{SqlitePool, SqlitePoolOptions};
use std::fs::{self, OpenOptions};
use std::io;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;
use tracing::info;

use crate::config::DB_PATH;

#[cfg(unix)]
fn create_db_file(path: &Path) -> io::Result<()> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map(|_| ())
}

#[cfg(not(unix))]
fn create_db_file(path: &Path) -> io::Result<()> {
    fs::File::create(path).map(|_| ())
}

#[cfg(unix)]
fn harden_file_permissions(path: &Path) {
    if path.exists() {
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .expect("Failed to set secure database file permissions");
    }
}

#[cfg(not(unix))]
fn harden_file_permissions(_path: &Path) {}

fn ensure_db_file() {
    let db_path = Path::new(DB_PATH);
    if !db_path.exists() {
        match create_db_file(db_path) {
            Ok(()) => {}
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {}
            Err(err) => panic!("Failed to create database file: {err}"),
        }
    }

    harden_file_permissions(db_path);
}

fn harden_sqlite_file_permissions() {
    harden_file_permissions(Path::new(DB_PATH));
    harden_file_permissions(Path::new(&format!("{DB_PATH}-wal")));
    harden_file_permissions(Path::new(&format!("{DB_PATH}-shm")));
}

pub async fn init_pool() -> Result<SqlitePool, sqlx::Error> {
    ensure_db_file();

    let db_url = format!("sqlite:{DB_PATH}");
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(&db_url)
        .await?;

    // Enable WAL mode for better concurrent read performance
    sqlx::query("PRAGMA journal_mode=WAL;")
        .execute(&pool)
        .await?;
    harden_sqlite_file_permissions();

    info!("Database pool initialized");
    Ok(pool)
}

pub async fn run_migrations(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let migrations = [
        include_str!("../migrations/001_initial_schema.sql"),
        include_str!("../migrations/002_favicons.sql"),
        include_str!("../migrations/003_vault_items.sql"),
    ];

    for migration_sql in &migrations {
        for statement in migration_sql.split(';') {
            let stmt = statement.trim();
            if !stmt.is_empty() {
                sqlx::query(stmt).execute(pool).await?;
            }
        }
    }

    ensure_vault_items_supports_passkeys(pool).await?;

    info!("Database migrations applied");
    Ok(())
}

async fn ensure_vault_items_supports_passkeys(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let table_sql: Option<String> = sqlx::query_scalar(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vault_items'",
    )
    .fetch_optional(pool)
    .await?;

    let Some(table_sql) = table_sql else {
        return Ok(());
    };

    if table_sql.contains("'passkey'") || table_sql.contains("\"passkey\"") {
        return Ok(());
    }

    let mut tx = pool.begin().await?;

    sqlx::query("DROP TABLE IF EXISTS vault_items_new")
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "CREATE TABLE vault_items_new (
            id                  TEXT PRIMARY KEY,
            item_type           TEXT NOT NULL CHECK (item_type IN ('card', 'address', 'passkey')),
            payload_encrypted   TEXT NOT NULL,
            created_at          TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO vault_items_new (id, item_type, payload_encrypted, created_at, updated_at)
         SELECT id, item_type, payload_encrypted, created_at, updated_at
         FROM vault_items
         WHERE item_type IN ('card', 'address', 'passkey')",
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query("DROP TABLE vault_items")
        .execute(&mut *tx)
        .await?;
    sqlx::query("ALTER TABLE vault_items_new RENAME TO vault_items")
        .execute(&mut *tx)
        .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_vault_items_type ON vault_items(item_type)")
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(())
}
