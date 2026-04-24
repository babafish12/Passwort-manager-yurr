use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

use crate::AppState;

#[derive(Debug, Serialize)]
pub struct HealthResponse {
    pub status: String,
    pub version: String,
}

fn health_response(status: &str) -> HealthResponse {
    HealthResponse {
        status: status.to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

pub async fn healthz() -> Json<HealthResponse> {
    Json(health_response("ok"))
}

pub async fn readyz(State(state): State<AppState>) -> Response {
    match sqlx::query_scalar::<_, i64>("SELECT 1")
        .fetch_one(&state.db)
        .await
    {
        Ok(_) => (StatusCode::OK, Json(health_response("ok"))).into_response(),
        Err(err) => {
            tracing::error!("Readiness check failed: {err}");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(health_response("unavailable")),
            )
                .into_response()
        }
    }
}
