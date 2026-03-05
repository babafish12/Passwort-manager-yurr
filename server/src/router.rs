use axum::routing::{delete, get, post, put};
use axum::Router;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;

use crate::auth;
use crate::entries;
use crate::generate;
use crate::AppState;

pub fn build_router(state: AppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let api = Router::new()
        // Auth routes
        .route("/auth/status", get(auth::status))
        .route("/auth/setup", post(auth::setup))
        .route("/auth/login", post(auth::login))
        .route("/auth/logout", post(auth::logout))
        .route("/auth/change-password", put(auth::change_password))
        // Entry routes
        .route("/entries", get(entries::list_entries))
        .route("/entries", post(entries::create_entry))
        .route("/entries/{id}", get(entries::get_entry))
        .route("/entries/{id}", put(entries::update_entry))
        .route("/entries/{id}", delete(entries::delete_entry))
        // Generate route
        .route("/generate", post(generate::generate_password));

    Router::new()
        .nest("/api/v1", api)
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
