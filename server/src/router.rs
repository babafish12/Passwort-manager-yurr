use axum::http::{header, Method};
use axum::routing::{delete, get, post, put};
use axum::Router;
use tower_http::cors::{AllowOrigin, AllowPrivateNetwork, CorsLayer};
use tower_http::trace::TraceLayer;

use crate::auth;
use crate::config;
use crate::entries;
use crate::favicons;
use crate::generate;
use crate::health;
use crate::vault_export;
use crate::vault_items;
use crate::AppState;

pub fn build_router(state: AppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|origin, _| {
            origin
                .to_str()
                .map(config::is_cors_origin_allowed)
                .unwrap_or(false)
        }))
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
        .allow_private_network(AllowPrivateNetwork::predicate(|origin, _| {
            origin
                .to_str()
                .map(config::is_cors_origin_allowed)
                .unwrap_or(false)
        }));

    let api = Router::new()
        // Auth routes
        .route("/auth/status", get(auth::status))
        .route("/auth/setup", post(auth::setup))
        .route("/auth/login", post(auth::login))
        .route("/auth/logout", post(auth::logout))
        .route("/auth/session", get(auth::session))
        .route("/auth/change-password", put(auth::change_password))
        // Entry routes
        .route("/entries", get(entries::list_entries))
        .route("/entries", post(entries::create_entry))
        .route("/entries/import", post(entries::bulk_import))
        .route("/entries/{id}", get(entries::get_entry))
        .route("/entries/{id}", put(entries::update_entry))
        .route("/entries/{id}", delete(entries::delete_entry))
        // Vault item routes
        .route("/vault-items", get(vault_items::list_vault_items))
        .route("/vault-items", post(vault_items::create_vault_item))
        .route("/vault-items/{id}", get(vault_items::get_vault_item))
        .route("/vault-items/{id}", put(vault_items::update_vault_item))
        .route("/vault-items/{id}", delete(vault_items::delete_vault_item))
        // Vault export/import routes
        .route("/vault/export", get(vault_export::export_vault))
        .route("/vault/import", post(vault_export::import_vault))
        // Favicon route
        .route("/favicons/{domain}", get(favicons::get_favicon_handler))
        // Generate route
        .route("/generate", post(generate::generate_password));

    Router::new()
        .route("/healthz", get(health::healthz))
        .route("/readyz", get(health::readyz))
        .nest("/api/v1", api)
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
