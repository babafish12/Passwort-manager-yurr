use sqlx::sqlite::{SqlitePool, SqlitePoolOptions};
use std::path::Path;
use tracing::info;

use crate::config::DB_PATH;

pub async fn init_pool() -> Result<SqlitePool, sqlx::Error> {
    // Create the database file if it doesn't exist
    if !Path::new(DB_PATH).exists() {
        std::fs::File::create(DB_PATH).expect("Failed to create database file");
    }

    let db_url = format!("sqlite:{DB_PATH}");
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(&db_url)
        .await?;

    // Enable WAL mode for better concurrent read performance
    sqlx::query("PRAGMA journal_mode=WAL;")
        .execute(&pool)
        .await?;

    info!("Database pool initialized");
    Ok(pool)
}

pub async fn run_migrations(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let migrations = [
        include_str!("../migrations/001_initial_schema.sql"),
        include_str!("../migrations/002_favicons.sql"),
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
