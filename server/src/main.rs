mod auth;
mod config;
mod crypto;
mod db;
mod entries;
mod errors;
mod generate;
mod models;
mod router;
mod session;
mod tls;

use sqlx::SqlitePool;

use crate::session::SessionStore;

#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    pub sessions: SessionStore,
}

#[tokio::main]
async fn main() {
    // Install rustls crypto provider before anything else
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .expect("Failed to install rustls crypto provider");

    tracing_subscriber::fmt::init();

    tracing::info!("Starting Yurrr Password Manager Server v{}", env!("CARGO_PKG_VERSION"));

    // Initialize database
    let pool = db::init_pool()
        .await
        .expect("Failed to initialize database");
    db::run_migrations(&pool)
        .await
        .expect("Failed to run migrations");

    // Initialize session store
    let sessions = SessionStore::new();

    // Ensure TLS certificates exist
    let (cert_pem, key_pem) = tls::ensure_certs();

    let state = AppState {
        db: pool,
        sessions,
    };

    let app = router::build_router(state);

    let addr = format!("{}:{}", config::SERVER_ADDR, config::SERVER_PORT);
    tracing::info!("Server listening on https://{addr}");

    let tls_config = axum_server::tls_rustls::RustlsConfig::from_pem(
        cert_pem.into_bytes(),
        key_pem.into_bytes(),
    )
    .await
    .expect("Failed to configure TLS");

    axum_server::bind_rustls(addr.parse().unwrap(), tls_config)
        .serve(app.into_make_service())
        .await
        .expect("Server failed");
}
