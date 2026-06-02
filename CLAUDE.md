# Yurrr Password Manager

Self-hosted password manager: Rust/Axum backend with SQLite + Brave browser extension (Manifest V3).
Deployed on Raspberry Pi, accessed from Arch laptop via local network.

## Architecture

- `server/src/` — Rust backend (Axum, sqlx/SQLite, AES-256-GCM, Argon2id, JWT, self-signed TLS)
- `extension/background/` — Service worker: message hub, API client, session management
- `extension/content/` — Content scripts: form detection, auto-fill, credential picker (Shadow DOM)
- `extension/popup/` — Popup UI: login, entry list, entry form, password generator
- `extension/options/` — Settings page: server URL config, CSV import
- `extension/lib/` — Shared constants and utilities
- `server/migrations/` — SQLite migration SQL files

## Commands

- `cargo build --release`: Build server (run from `server/`)
- `cargo run --release`: Start server on https://0.0.0.0:8443 (run from `server/`)
- Extension: load `extension/` as unpacked extension in Brave/Chrome

## API Routes

Base: `/api/v1` (defined in `server/src/router.rs`)

- Auth: `GET /auth/status`, `POST /auth/{setup,login,logout}`, `PUT /auth/change-password`
- Entries: `GET|POST /entries`, `GET|PUT|DELETE /entries/{id}`, `POST /entries/import`
- Other: `POST /generate`, `GET /favicons/{domain}`

## Security Model

- Master password → Argon2id (16MB, 2 iterations, 2 threads) → AES-256-GCM encryption key
- Key held in server RAM only during active sessions, never on disk
- Each entry encrypted with random 12-byte nonce
- JWT tokens: 1 hour expiry, 15 min inactivity timeout
- Rate limiting on login: 5 req/s burst
- IMPORTANT: Never commit `vault.db`, `certs/`, or `.pem` files

## Extension Conventions

- All JS uses ES modules (`"type": "module"` in manifest)
- Content scripts use Shadow DOM for style isolation
- Session modes: `ephemeral` (lock on browser restart) or `persistent` (lock on system idle)
- Constants centralized in `extension/lib/constants.js`

## Deployment

- Target: Raspberry Pi with systemd service (`/etc/systemd/system/yurrr.service`)
- Pi addresses: Ethernet `10.187.187.102`, WiFi `10.187.187.106`, Tailscale `100.118.2.12`
- Port 8443 must be open: `ufw allow 8443/tcp`
- Argon2id parameters in `server/src/config.rs` are tuned for Pi hardware

## Gotchas

- rustls requires `aws_lc_rs` crypto provider — installed in `main.rs` before anything else
- Self-signed TLS: browser must accept the cert before extension can connect
- Extension does cert warmup on popup open to handle browser restart scenarios
- CSV import parser handles RFC 4180 (quoted fields, commas in passwords)
- Favicon fetching: Google API first, direct `/favicon.ico` fallback
