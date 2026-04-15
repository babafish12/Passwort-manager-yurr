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

### v0.6.0 — Email Selection, Cards/Addresses Tabs, and Session-Loss Handling

- **Email suggestions** are now combined from:
  - manually configured addresses in extension settings
  - auto-detected addresses from visited pages
  - optional import of email usernames from the unlocked vault
- Auto-detected emails can now be **enabled/disabled individually** in Settings:
  - per-email checkbox list
  - `Select All` / `Select None`
  - only selected auto-detected emails are suggested in forms
- Popup now includes vault section tabs: **Passwords**, **Cards**, and **Addresses**
  - Cards and addresses can be added, edited, searched, and deleted directly in the popup
  - Card type is auto-detected (Visa, Mastercard, Amex, Discover, JCB, Diners) and card numbers are validated with Luhn checks
  - Cards/addresses are currently stored locally in extension storage (`chrome.storage.local`)
- Session/network behavior hardened:
  - API calls retry once on transient fetch/network errors
  - if a protected request fails with auth/network loss, the extension force-locks locally and requires re-login

### v0.5.0 — Configurable Inactivity Timeout

- The **inactivity timeout** is now configurable in extension settings (Security section)
- When "Lock after inactivity (relaxed)" mode is selected, a new input field appears to set the timeout in minutes (1–1440)
- Default remains 15 minutes
- Setting is stored in browser storage and applied to both the auto-lock alarm and session recovery after browser restart

---

### v0.4.0 — Session Persistence Setting

- New **Session Persistence** option in extension settings (right-click → Options → Security)
- Two modes:
  - **Lock on browser restart** (default) — same behavior as before
  - **Keep unlocked until laptop locks** — session survives browser restarts, auto-locks when the system screen locks
- Uses `chrome.idle` API for system lock detection
- Switching modes forces a re-login for security
- Self-signed cert warmup on popup open to ensure persistent sessions work after browser restart

---

### v0.3.0 — Credential Picker & Save-Password Fix

#### Credential Picker
- When clicking on a login field, a dropdown now shows all saved credentials for that site
- Select any credential to auto-fill username and password
- Shadow DOM rendering — styles are fully isolated from page CSS
- Closes on Escape, outside click, or after selection

#### Save-Password Prompt Fix
- The "Save password?" banner no longer disappears when the page navigates after login
- Credentials are temporarily stored in the service worker and the banner appears on the next page
- Auto-expires after 30 seconds

#### Multi-Step Login Support (e.g. Google)
- Password-only steps (no visible username field) are now handled correctly
- Form submission works even when the username was entered on a previous page

---

### v0.2.1 — UI Polish & Fixes

- Rounder corners throughout the extension popup (10-12px border-radius)
- Subtler borders and glow effects on focus states
- Bigger entry icons (36px) with smoother hover transitions
- Thin custom scrollbar for the entry list
- Auto-focus search input when opening the extension — start typing immediately to filter
- Fixed login screen showing behind the entry list when already unlocked
- Server status dot now polls every 3 seconds instead of checking only once

---

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
