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

    info!("Database migrations applied");
    Ok(())
}
