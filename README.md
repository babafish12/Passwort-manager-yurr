# Yurrr Password Manager

Yurrr is a self-hosted password manager for a local Rust server and a
Brave/Chrome extension. It is built for a private setup: the vault lives on your
own machine, the browser extension talks to it over HTTPS, and there is no
hosted sync service in the middle.

The server stores encrypted secrets in SQLite. The extension provides the
day-to-day UI: unlock, search, copy, autofill, generate passwords, import CSV
exports, export the vault, and manage cards, addresses, and passkey metadata.

## At a glance

| Area | What Yurrr does |
| --- | --- |
| Hosting | Runs on your own Linux machine, including Raspberry Pi. |
| Browser | Manifest V3 extension for Brave and Chrome. |
| Storage | SQLite database on local disk. |
| Crypto | Argon2id master-password hashing and AES-256-GCM encrypted secrets. |
| Network | HTTPS API with generated self-signed certificates by default. |
| Privacy | No cloud sync; optional server-side favicon fetching stays disabled unless enabled. |

## Contents

- [Features](#features)
- [Architecture](#architecture)
- [Security model](#security-model)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Installation](#installation)
- [Browser extension setup](#browser-extension-setup)
- [First use](#first-use)
- [Daily use](#daily-use)
- [Configuration](#configuration)
- [Backups and updates](#backups-and-updates)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Project layout](#project-layout)
- [Roadmap](#roadmap)

## Features

- Self-hosted Rust server with SQLite storage.
- Manifest V3 Brave/Chrome extension.
- Master-password protected vault initialization and login.
- AES-256-GCM encryption for stored password secrets and notes.
- Argon2id master-password hashing and key derivation.
- Password list, search, detail view, add, edit, delete, copy, and reveal.
- Domain-aware autofill for saved login forms.
- Save prompt after trusted login/signup form submission.
- Password generator with configurable character groups.
- CSV import from Chrome, Brave, and Firefox password exports.
- Decrypted JSON vault export with typed confirmation and fresh master-password
  verification on the server.
- Extra vault item storage for cards, addresses, and passkey metadata.
- Email suggestions for signup forms, capped to avoid noisy overlays.
- Email suggestions are hidden when the current website already has a saved
  account in the vault.
- Session modes:
  - Lock on browser restart.
  - Lock when the laptop locks.
  - Lock after inactivity.
  - Never auto-lock until manual lock, password change, or server restart.
- Three-stage favicon support: browser cache, direct website discovery, then
  cached server fallback.
- CORS restrictions for extension and local/private origins.
- HTTPS by default with generated self-signed certificates.
- WAL-aware update script with database backup support.

## Architecture

```text
Browser extension  -- HTTPS / JSON API -->  Yurrr server  -->  SQLite vault.db
Brave or Chrome                             Rust + Axum       local disk
```

The server owns the database and the encryption key during an unlocked session.
The extension owns the browser UX and receives decrypted credentials only when
the vault is unlocked and an operation needs them, such as display, copy, or
autofill.

The default server address is:

```text
https://localhost:8443
```

On a Raspberry Pi or another LAN host, use that machine's reachable IP or DNS
name:

```text
https://192.168.1.50:8443
https://your-hostname.local:8443
https://your-tailscale-ip:8443
```

## Security model

### What is stored encrypted

- Login passwords.
- Login notes.
- Card payloads.
- Address payloads.
- Passkey metadata payloads.
- Decrypted vault export is generated only after re-entering the master
  password.

### What is not stored

- The master password itself is not stored.
- The raw encryption key is not written to disk.
- Pending credentials from form submissions are kept in service-worker memory,
  not browser extension storage.

### What is stored as metadata

The current schema keeps some metadata in plaintext so the UI and domain
matching can work without decrypting every password row:

- Website URL.
- Website domain.
- Username.
- Favorite flag.
- Created and updated timestamps.
- Vault item type, for example `card`, `address`, or `passkey`.
- Cached favicons, if enabled and fetched.
- Basic audit events.

This means `vault.db` protects the secret fields, but it still reveals which
sites and usernames exist. Metadata encryption is listed in the roadmap.

### How sessions work

- On login, the server verifies the master password and derives the vault key.
- The vault key stays in server RAM for the active session.
- The server creates a JWT signed with an in-memory secret.
- Restarting the server invalidates all sessions because the JWT signing secret
  and session keys are regenerated.
- Normal sessions have a JWT max age and server-side inactivity timeout.
- `Never auto-lock` creates a non-expiring token and a server session without an
  inactivity deadline. It still ends on manual lock, password change, or server
  restart.

### Network security

- The server listens on HTTPS, even when using the generated self-signed
  certificate.
- The generated certificate encrypts traffic, but browsers need a manual
  exception unless you install a trusted certificate with matching DNS/IP SANs.
- By default, CORS allows browser-extension origins and local/private HTTP(S)
  origins.
- For stricter deployments, set `YURRR_CORS_ALLOWED_ORIGINS` to exact origins.

### Important limits

- Anyone who controls the browser profile while the vault is unlocked can act as
  the extension user.
- `Never auto-lock` improves convenience but increases exposure on a shared or
  unlocked computer.
- JSON export is decrypted. Store export files only in a trusted encrypted
  location and delete temporary copies.
- Stored passkeys are metadata records. Yurrr does not implement a WebAuthn
  authenticator or browser passkey provider yet.

## Requirements

Server:

- Linux recommended, Raspberry Pi supported.
- Rust toolchain with Cargo.
- `systemd` if you want auto-start on boot.
- Network access from the browser machine to TCP port `8443`.

Browser:

- Brave or Chrome with extension developer mode.
- Ability to load an unpacked Manifest V3 extension.

Optional tools:

- `git` for updates.
- `ufw` or your firewall tool if the server has a firewall enabled.
- Tailscale if you want private remote access without exposing the server to the
  public internet.

## Quick start

This is the shortest working path for a local development or first self-hosted
setup. Use the detailed sections below when moving the server to a Raspberry Pi,
systemd service, LAN address, or Tailscale address.

```bash
git clone https://github.com/babafish12/Passwort-manager-yurr.git yurrr
cd yurrr/server
cargo run --release
```

Then open this URL in Brave/Chrome and accept the generated certificate for the
exact host you will use in the extension:

```text
https://localhost:8443/api/v1/auth/status
```

Load the extension:

1. Open `brave://extensions` or `chrome://extensions`.
2. Enable developer mode.
3. Select `Load unpacked`.
4. Choose the repository's `extension/` directory.
5. Open the Yurrr options page and set the server URL to
   `https://localhost:8443`.

Create the vault from the popup, then add or import passwords.

## Installation

### 1. Clone the repository

On the server machine:

```bash
git clone https://github.com/babafish12/Passwort-manager-yurr.git yurrr
cd yurrr
```

If you already have the repository, pull the latest version:

```bash
cd /path/to/yurrr
git pull --ff-only
```

### 2. Install Rust if needed

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
```

Check that Cargo works:

```bash
cargo --version
```

### 3. Build the server

```bash
cd /path/to/yurrr/server
cargo build --release
```

The release binary is created at:

```text
server/target/release/yurrr-server
```

### 4. Run the server manually

```bash
cd /path/to/yurrr/server
./target/release/yurrr-server
```

On first start, the server creates:

- `server/vault.db`
- `server/vault.db-wal` and `server/vault.db-shm` after WAL mode is active
- `server/certs/` with generated TLS files

It listens on:

```text
https://0.0.0.0:8443
```

Check the server:

```bash
curl -sk https://localhost:8443/api/v1/auth/status
```

Expected response before vault setup:

```json
{"initialized":false,"server_version":"0.1.0"}
```

### 5. Run the server with systemd

Create a service file. Replace the user and paths with your real server user
and repository path.

```bash
sudo tee /etc/systemd/system/yurrr.service >/dev/null <<'EOF'
[Unit]
Description=Yurrr Password Manager Server
After=network.target

[Service]
Type=simple
User=piper
WorkingDirectory=/home/piper/yurrr/server
ExecStart=/home/piper/yurrr/server/target/release/yurrr-server
Restart=on-failure
RestartSec=5

# Optional: exact CORS allowlist for stricter deployments.
# Environment=YURRR_CORS_ALLOWED_ORIGINS=chrome-extension://<extension-id>,https://192.168.1.50:8443

# Optional: normal server session limits.
# Environment=YURRR_JWT_EXPIRY_HOURS=24
# Environment=YURRR_INACTIVITY_TIMEOUT_MINUTES=240

# Optional: allow server-side favicon fetching from saved domains.
# Environment=YURRR_ENABLE_THIRD_PARTY_FAVICONS=true

[Install]
WantedBy=multi-user.target
EOF
```

Enable and start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable yurrr
sudo systemctl start yurrr
```

Check status and logs:

```bash
sudo systemctl status yurrr
journalctl -u yurrr -f
```

### 6. Open the firewall port if needed

```bash
sudo ufw allow 8443/tcp
```

Use the equivalent rule if you use another firewall.

## Browser extension setup

### 1. Accept the self-signed certificate

Open this URL in Brave/Chrome before using the extension:

```text
https://<server-ip-or-hostname>:8443/api/v1/auth/status
```

Example:

```text
https://192.168.1.50:8443/api/v1/auth/status
```

The browser will show a certificate warning for the generated self-signed cert.
Open the advanced section and proceed to the site. You should see the JSON
status response.

This browser exception is per browser profile and per host/IP. If you switch
from LAN IP to Tailscale IP, accept the certificate for the new URL too.

### 2. Load the unpacked extension

1. Open `brave://extensions` or `chrome://extensions`.
2. Enable developer mode.
3. Select `Load unpacked`.
4. Choose the repository's `extension/` directory.
5. Pin the Yurrr extension icon if you want quick access.

### 3. Configure the server URL

1. Open the Yurrr extension options page.
2. Set `Server URL` to your server, for example:

   ```text
   https://192.168.1.50:8443
   ```

3. Select `Test Connection`.
4. Select `Save`.

## First use

1. Open the Yurrr extension popup.
2. If the server is reachable and uninitialized, create a master password.
3. Unlock with the same master password.
4. Add the first login manually or import a CSV file from the options page.

The master password must be at least 8 characters. Use a long unique passphrase.
If you lose it, the encrypted vault cannot be decrypted.

## Daily use

### Popup states

When the popup opens, Yurrr first shows a short loading state while it checks
the saved session and server status. This prevents the extension from flashing a
blank or half-rendered login screen during startup. If the vault is already
unlocked and the server session is valid, the popup moves directly to the vault
list. If the server is offline, the popup keeps the login screen visible with a
clear server-status message and retries while it is open.

The popup vault list uses separate sections for passwords, passkeys, cards, and
addresses. These section controls support mouse and keyboard navigation with
arrow keys, Home, and End. Rows have a primary open action and a separate delete
action so keyboard and screen-reader users do not have nested controls.

### Add a login manually

1. Open the popup.
2. Select the add button.
3. Enter website URL, username, password, and optional notes.
4. Use the generator if you need a new password.
5. Save.

### Autofill a saved login

1. Visit a login page.
2. Yurrr checks saved entries for the current domain.
3. Focus the username or password field and choose the account from the picker.
4. To fill matching logins automatically, enable `Autofill saved logins
   automatically` in the options page.

Automatic autofill is opt-in. When enabled, Yurrr fills only matching login
forms on the active top-level page. If a page has multiple saved accounts, Yurrr
uses a typed or remembered username, the last account you picked manually, or a
single unambiguous match; otherwise it keeps the picker available instead of
guessing.

### Save a login after submitting a form

When you submit a trusted login/signup form, Yurrr can show a save banner. The
pending credential is scoped to the tab/frame and kept in extension service
worker memory until saved, dismissed, replaced, or cleared.

### Generate a password

The generator is available in the popup and on detected password fields. The
default length is 20 characters. Generated suggestions are shown only when they
fit the current page context.

### Email suggestions

Email suggestions are managed in the options page:

- Add manual email suggestions, one per line.
- Import known email usernames from the vault.
- Select which auto-detected emails are active.

The extension caps visible suggestions and does not show them on a website that
already has a saved account in the vault.

### Website favicons

Favicon display is enabled by default and can be turned off in the options page.
When enabled, the popup tries icons in this order:

1. The browser's own favicon cache through the Manifest V3 `_favicon` API.
2. Direct website discovery from the saved URL and domain root, including
   `rel="icon"`, Apple touch icons, web manifests, SVG icons, PNG/WebP/ICO
   icons, and common paths such as `/favicon.ico`.
3. The server's cached `/api/v1/favicons/{domain}` response.

The server does not fetch favicons from websites by default. Server-side
favicon fetching is controlled separately with
`YURRR_ENABLE_THIRD_PARTY_FAVICONS=true`. Keep that disabled if you do not want
the server to make network requests for saved domains.

### Import passwords

Open the options page and use `Import Passwords`.

Supported CSV sources:

- Chrome
- Brave
- Firefox

Recommended import flow:

1. Export passwords from the browser password manager.
2. Select the matching browser type.
3. Choose the CSV file.
4. Preview the parsed entries.
5. Keep `Skip duplicates` enabled unless you want conflicts to fail.
6. Import.
7. Delete the browser-exported CSV after the import.

Duplicate detection uses the same website/domain and username.

### Export the vault

Open the options page and use `Export Vault`.

Export protections:

- The UI requires typed confirmation.
- The UI asks for the master password again.
- The server verifies that master password before decrypting export data.
- The export is a decrypted JSON file.

Store the exported file in an encrypted location.

### Cards, addresses, and passkeys

The popup includes sections for:

- Passwords.
- Cards.
- Addresses.
- Passkeys.

Cards, addresses, and passkeys are stored as encrypted vault item payloads. Card
and address browser autofill is not implemented yet. Passkeys are stored as
metadata only and are not usable as a WebAuthn authenticator.

### Locking behavior

Configure the session mode in the options page:

| Mode | Behavior |
| --- | --- |
| Lock on browser restart | Token is kept in session storage and removed by browser session lifecycle. |
| Lock when laptop locks | Token is kept locally, but the extension locks when the system becomes locked. |
| Lock after inactivity | Token is kept locally and an inactivity alarm locks the vault after the configured minutes. |
| Never auto-lock | Token is kept locally and the server session has no inactivity expiry. |

Manual lock is always available from the popup.

## Configuration

### Server environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `YURRR_JWT_EXPIRY_HOURS` | `24` | Normal JWT max age in hours. Ignored for `Never auto-lock` sessions. |
| `YURRR_INACTIVITY_TIMEOUT_MINUTES` | `240` | Server-side inactivity timeout for normal sessions. Ignored for `Never auto-lock` sessions. |
| `YURRR_CORS_ALLOWED_ORIGINS` | unset | Comma-separated exact-origin allowlist. If unset, extension origins and local/private HTTP(S) origins are allowed. |
| `YURRR_ENABLE_THIRD_PARTY_FAVICONS` | `false` | Allows the server fallback to fetch favicons for saved domains. Popup browser/website discovery works without this. |

### Update script environment variables

The repository includes `scripts/update-server.sh`.

| Variable | Default | Description |
| --- | --- | --- |
| `YURRR_SERVICE_NAME` | `yurrr` | systemd service name. |
| `YURRR_REPO_DIR` | repository root | Repository to update. |
| `YURRR_SERVER_DIR` | `$YURRR_REPO_DIR/server` | Server directory. |
| `YURRR_BACKUP_DIR` | `$YURRR_SERVER_DIR/backups` | Backup directory for SQLite files. |
| `YURRR_ALLOW_DIRTY` | `0` | Set to `1` to allow update with a dirty working tree. |
| `YURRR_SKIP_BACKUP` | `0` | Set to `1` to skip database backup. |

### Extension settings

The options page manages:

- Server URL.
- Favicon display in the popup.
- Session persistence and inactivity timeout.
- Opt-in automatic autofill for saved logins.
- Manual and auto-detected email suggestions.
- CSV import.
- Vault export.

## Backups and updates

### Backup the database

SQLite runs in WAL mode. For file-level backups, copy these files together:

```text
server/vault.db
server/vault.db-wal
server/vault.db-shm
```

The safest manual backup is:

```bash
sudo systemctl stop yurrr
cp -a /path/to/yurrr/server/vault.db* /secure/backup/location/
sudo systemctl start yurrr
```

Keep backups private. They contain encrypted secrets plus plaintext metadata.

### Update server code

Use the update script from the repository root:

```bash
./scripts/update-server.sh
```

The script:

1. Checks required commands.
2. Refuses dirty working trees unless `YURRR_ALLOW_DIRTY=1`.
3. Fetches and pulls with `--ff-only`.
4. Builds the release server.
5. Stops the service.
6. Backs up `vault.db`, `vault.db-wal`, and `vault.db-shm` when present.
7. Starts the service again.
8. Prints service status.

### Update the extension

After pulling new code on the browser machine:

1. Open `brave://extensions` or `chrome://extensions`.
2. Find Yurrr.
3. Select the reload button on the extension card.
4. Reopen the popup.

If the extension files are copied from the server to another machine, copy the
updated `extension/` directory before reloading.

Popup-only UI changes do not require restarting the Yurrr server. Reloading the
extension is enough. Restart the server only when server code, server
configuration, TLS files, environment variables, or the systemd service changes.

## Development

### Run server tests

```bash
cargo test --manifest-path server/Cargo.toml
```

### Check extension JavaScript syntax

```bash
find extension -name '*.js' -print0 | xargs -0 -n1 node --check
```

### Check whitespace in the Git diff

```bash
git diff --check
```

### Useful API routes

Health:

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | Basic process health. |
| `GET` | `/readyz` | Readiness check. |

Auth:

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/auth/status` | Initialization and server version. |
| `POST` | `/api/v1/auth/setup` | Initialize the vault. |
| `POST` | `/api/v1/auth/login` | Unlock and create a session. |
| `POST` | `/api/v1/auth/logout` | Remove the current session. |
| `GET` | `/api/v1/auth/session` | Check current session validity. |
| `PUT` | `/api/v1/auth/change-password` | Change master password and re-encrypt vault data. |

Vault:

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/entries` | List password entries. |
| `POST` | `/api/v1/entries` | Create password entry. |
| `POST` | `/api/v1/entries/import` | Bulk import password entries. |
| `GET` | `/api/v1/entries/{id}` | Get decrypted password detail. |
| `PUT` | `/api/v1/entries/{id}` | Update password entry. |
| `DELETE` | `/api/v1/entries/{id}` | Delete password entry. |
| `GET` | `/api/v1/vault-items` | List cards, addresses, or passkeys. |
| `POST` | `/api/v1/vault-items` | Create card, address, or passkey item. |
| `GET` | `/api/v1/vault-items/{id}` | Get vault item. |
| `PUT` | `/api/v1/vault-items/{id}` | Update vault item. |
| `DELETE` | `/api/v1/vault-items/{id}` | Delete vault item. |
| `POST` | `/api/v1/vault/export` | Export decrypted vault after fresh master-password check. |
| `POST` | `/api/v1/vault/import` | Import vault JSON. |
| `POST` | `/api/v1/generate` | Generate password. |
| `GET` | `/api/v1/favicons/{domain}` | Return cached favicon or fetch only when enabled. |

Authenticated routes require:

```text
Authorization: Bearer <token>
```

## Troubleshooting

### Extension says the connection failed

- Confirm the server is running:

  ```bash
  sudo systemctl status yurrr
  ```

- Open the status URL directly in the browser and accept the certificate:

  ```text
  https://<server-ip-or-hostname>:8443/api/v1/auth/status
  ```

- Confirm the extension options page has the same server URL.
- Confirm the firewall allows TCP `8443`.
- Check server logs:

  ```bash
  journalctl -u yurrr -f
  ```

### Browser blocks the self-signed certificate

Accept the certificate exception for the exact host/IP you use in the extension.
For strict certificate validation, replace the generated certificate with one
that contains your DNS name or IP address as a Subject Alternative Name.

### Login is slow on Raspberry Pi

Argon2id is intentionally CPU and memory intensive. The current parameters are
tuned for Raspberry Pi:

```text
memory cost: 16384 KiB
time cost: 2
parallelism: 2
```

### Session expired

Unlock again with the master password. Normal server sessions default to 24
hours max JWT age and 240 minutes inactivity. The extension inactivity mode
defaults to 15 minutes unless changed in options. `Never auto-lock` sessions end
only on manual lock, password change, or server restart.

### Autofill misses a form

Some sites use unusual forms, shadow DOM, iframes, multi-step login screens, or
custom controls. Use the popup to copy credentials manually when detection does
not match the page.

### Email suggestions do not show

Yurrr intentionally hides email suggestions when the current website already has
a saved account. Suggestions also require an unlocked vault when they depend on
vault usernames.

### Favicons are missing

- Reload the extension after pulling new code because Manifest V3 permission
  changes are read only when the extension reloads.
- Confirm `Show website favicons in the popup` is enabled in the options page.
- Open the site once in Brave/Chrome. The popup uses the browser favicon cache
  as its fastest source.
- If the browser cache does not have a good icon, the popup attempts direct
  website discovery from the saved URL and the domain root.
- Server-side favicon fetching is optional. Set
  `YURRR_ENABLE_THIRD_PARTY_FAVICONS=true` only if you also want the server
  fallback to fetch and cache icons for saved domains.
- Some sites block extension-origin requests or require authenticated page
  state. Those entries fall back to the letter icon.

### Import fails

- Confirm the selected browser type matches the CSV format.
- Preview the CSV before import.
- Keep `Skip duplicates` enabled for repeated imports.
- Delete temporary CSV exports after use.

## Project layout

```text
.
|-- extension/
|   |-- background/       Extension service worker, API client, session logic
|   |-- content/          Form detection, overlays, autofill, save prompts
|   |-- lib/              Shared extension constants and utilities
|   |-- options/          Settings, import, export, email suggestions
|   `-- popup/            Main extension UI and components
|-- scripts/
|   `-- update-server.sh  Pull, build, backup, restart systemd service
|-- server/
|   |-- migrations/       SQLite schema
|   |-- src/              Rust server modules
|   `-- Cargo.toml        Server dependencies
|-- README.md
`-- USAGE.md             Older step-by-step usage notes
```

## Roadmap

- Encrypted restore UI for full vault exports.
- Metadata encryption for website domains, URLs, usernames, labels, and item
  metadata.
- Real WebAuthn/passkey integration instead of stored passkey metadata.
- Card and address autofill.
- Stronger certificate deployment guide for DNS/IP SAN certificates.
- Optional packaged extension release flow.
