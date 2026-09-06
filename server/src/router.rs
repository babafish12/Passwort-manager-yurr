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
        .route("/vault/export", post(vault_export::export_vault))
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use reqwest::Client;
    use serde_json::{json, Value};
    use sqlx::sqlite::SqlitePoolOptions;

    struct TestServer {
        base: String,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for TestServer {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn test_server() -> TestServer {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::run_migrations(&pool).await.unwrap();
        let app = build_router(AppState {
            db: pool,
            sessions: crate::session::SessionStore::new(),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/api/v1", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        TestServer { base, task }
    }

    async fn request(
        client: &Client,
        server: &TestServer,
        method: &str,
        path: &str,
        token: &str,
        body: Value,
    ) -> (StatusCode, Value) {
        let mut req = client.request(method.parse().unwrap(), format!("{}{path}", server.base));
        if !token.is_empty() {
            req = req.bearer_auth(token);
        }
        if !body.is_null() {
            req = req
                .header("content-type", "application/json")
                .body(body.to_string());
        }
        let response = req.send().await.unwrap();
        let status = response.status();
        (
            status,
            serde_json::from_str(&response.text().await.unwrap()).unwrap(),
        )
    }

    #[tokio::test]
    async fn vault_lifecycle_preserves_port_isolation_and_rekeys_every_item() {
        let server = test_server().await;
        let client = Client::new();
        let (status, _) = request(
            &client,
            &server,
            "POST",
            "/auth/setup",
            "",
            json!({"master_password":"test-master-password"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (status, login) = request(
            &client,
            &server,
            "POST",
            "/auth/login",
            "",
            json!({"master_password":"test-master-password"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let token = login["token"].as_str().unwrap();
        let entry = |port| json!({"website_url":format!("http://192.168.1.10:{port}/login"), "username":"admin", "password":format!("test-secret-{port}"), "notes":"delete me"});
        let (status, first) =
            request(&client, &server, "POST", "/entries", token, entry(8080)).await;
        assert_eq!(status, StatusCode::CREATED);
        let (status, second) =
            request(&client, &server, "POST", "/entries", token, entry(9000)).await;
        assert_eq!(
            status,
            StatusCode::CREATED,
            "same IP and username, different port must be allowed"
        );
        assert_eq!(
            first["website_domain"], second["website_domain"],
            "existing metadata stays compatible"
        );
        let (status, _) = request(&client, &server, "POST", "/entries", token, entry(8080)).await;
        assert_eq!(status, StatusCode::CONFLICT);
        let second_path = format!("/entries/{}", second["id"].as_str().unwrap());
        let (status, _) = request(&client, &server, "PUT", &second_path, token, entry(8080)).await;
        assert_eq!(
            status,
            StatusCode::CONFLICT,
            "editing cannot overwrite another service's login"
        );
        let (status, _) = request(
            &client,
            &server,
            "PUT",
            &second_path,
            token,
            json!({"notes":""}),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::OK,
            "a rejected update must release its transaction"
        );
        let (_, detail) = request(&client, &server, "GET", &second_path, token, Value::Null).await;
        assert!(detail["notes"].is_null());
        assert_eq!(detail["password"], "test-secret-9000");
        for (port, id) in [(8080, &first["id"]), (9000, &second["id"])] {
            let (status, list) = request(
                &client,
                &server,
                "GET",
                &format!("/entries?domain=192.168.1.10:{port}"),
                token,
                Value::Null,
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(list.as_array().unwrap().len(), 1);
            assert_eq!(&list[0]["id"], id);
        }
        let (_, list) = request(
            &client,
            &server,
            "GET",
            "/entries?domain=192.168.1.10:7000",
            token,
            Value::Null,
        )
        .await;
        assert!(list.as_array().unwrap().is_empty());
        let (_, imported) = request(
            &client,
            &server,
            "POST",
            "/entries/import",
            token,
            json!({"entries":[entry(8080),entry(9200)],"skip_duplicates":true}),
        )
        .await;
        assert_eq!(imported["imported"], 1);
        assert_eq!(imported["skipped"], 1);
        let (status, _) = request(&client, &server, "POST", "/vault-items", token, json!({"item_type":"address", "payload":{"full_name":"Test Address", "line1":"Example Street"}})).await;
        assert_eq!(status, StatusCode::CREATED);
        let (status, _) = request(
            &client,
            &server,
            "POST",
            "/vault/export",
            token,
            json!({"master_password":"wrong-password"}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _) =
            request(&client, &server, "GET", "/auth/session", token, Value::Null).await;
        assert_eq!(
            status,
            StatusCode::OK,
            "an export typo must not destroy the session"
        );
        let (status, mut exported) = request(
            &client,
            &server,
            "POST",
            "/vault/export",
            token,
            json!({"master_password":"test-master-password"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(exported["passwords"].as_array().unwrap().len(), 3);
        assert_eq!(exported["vault_items"].as_array().unwrap().len(), 1);
        let mut new_service = exported["passwords"][0].clone();
        new_service["id"] = json!("imported-new-service");
        new_service["website_url"] = json!("http://192.168.1.10:9300");
        exported["passwords"]
            .as_array_mut()
            .unwrap()
            .push(new_service);
        let (_, imported) =
            request(&client, &server, "POST", "/vault/import", token, exported).await;
        assert_eq!(imported["skipped_passwords"], 3);
        assert_eq!(imported["skipped_vault_items"], 1);
        assert_eq!(imported["imported_passwords"], 1);
        let (status, _) = request(&client, &server, "PUT", "/auth/change-password", token, json!({"current_password":"test-master-password", "new_password":"new-test-master-password"})).await;
        assert_eq!(status, StatusCode::OK);
        let (status, _) = request(&client, &server, "GET", "/entries", token, Value::Null).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, login) = request(
            &client,
            &server,
            "POST",
            "/auth/login",
            "",
            json!({"master_password":"new-test-master-password"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let token = login["token"].as_str().unwrap();
        let (_, detail) = request(&client, &server, "GET", &second_path, token, Value::Null).await;
        assert_eq!(detail["password"], "test-secret-9000");
        let (_, addresses) = request(
            &client,
            &server,
            "GET",
            "/vault-items?type=address",
            token,
            Value::Null,
        )
        .await;
        assert_eq!(addresses[0]["payload"]["full_name"], "Test Address");
        let (status, _) =
            request(&client, &server, "DELETE", &second_path, token, Value::Null).await;
        assert_eq!(status, StatusCode::OK);
        let (status, _) = request(&client, &server, "GET", &second_path, token, Value::Null).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
}
