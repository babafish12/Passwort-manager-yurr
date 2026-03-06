# Yurrr Password Manager

A self-hosted password manager with a Rust backend and Brave browser extension.

```
[Arch Laptop w/ Brave]  --HTTPS-->  [Raspberry Pi Server]
     (extension)                     (Rust + SQLite)
```

All passwords are encrypted with AES-256-GCM, keys derived via Argon2id. The encryption key only exists in server RAM during your session — never written to disk.

See [USAGE.md](USAGE.md) for the full setup and usage guide.

---

## Changelog

### v0.2.0 — Website Favicons & Password Import

#### Website Favicons

- The extension now displays the actual website favicon next to each password entry instead of just the first letter of the domain
- Favicons are fetched automatically when a new entry is created or updated
- Fetching happens in the background (Google Favicon API with direct `/favicon.ico` fallback) — no delay when saving
- Favicons are cached server-side in SQLite (deduplicated per domain) and client-side in the service worker
- Graceful fallback: if no favicon is available, the colored letter icon is still shown
- New API endpoint: `GET /api/v1/favicons/{domain}`

#### Browser Password Import

- Import passwords from **Chrome**, **Brave**, and **Firefox** via CSV export
- Available on the extension's **Options page** (right-click extension icon → Options)
- Workflow: select browser → choose CSV file → preview entries → import
- Duplicate detection: entries with the same domain + username are skipped by default
- Supports RFC 4180 CSV parsing (handles quoted fields, commas in passwords, etc.)
- Import results show how many entries were imported, skipped, or failed
- Includes step-by-step export instructions for each browser
- New API endpoint: `POST /api/v1/entries/import`

#### Technical Details

**New files:**
- `server/migrations/002_favicons.sql` — favicon cache table
- `server/src/favicons.rs` — favicon fetching, storage, and serving
- `extension/options/csv-parser.js` — browser CSV parser

**New dependency:**
- `reqwest 0.12` (rustls-tls) — HTTP client for favicon fetching

---

### v0.1.0 — Initial Release

- Rust backend with Axum + SQLite
- AES-256-GCM encryption, Argon2id key derivation
- Brave extension (Manifest V3) with popup UI
- Auto-fill and auto-save on login forms
- Password generator with strength indicator
- Auto-lock after 15 minutes of inactivity
- Self-signed TLS certificates
- systemd service support for Raspberry Pi
