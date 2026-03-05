CREATE TABLE IF NOT EXISTS master_config (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    password_hash   TEXT    NOT NULL,
    encryption_salt TEXT    NOT NULL,
    argon2_m_cost   INTEGER NOT NULL DEFAULT 65536,
    argon2_t_cost   INTEGER NOT NULL DEFAULT 3,
    argon2_p_cost   INTEGER NOT NULL DEFAULT 4,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS entries (
    id                  TEXT    PRIMARY KEY,
    website_url         TEXT    NOT NULL,
    website_domain      TEXT    NOT NULL,
    username            TEXT    NOT NULL,
    password_encrypted  TEXT    NOT NULL,
    notes_encrypted     TEXT,
    favorite            INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_entries_domain ON entries(website_domain);

CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type  TEXT    NOT NULL,
    details     TEXT,
    ip_address  TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
