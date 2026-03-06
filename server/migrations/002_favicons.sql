CREATE TABLE IF NOT EXISTS favicons (
    domain      TEXT PRIMARY KEY,
    image_data  BLOB NOT NULL,
    mime_type   TEXT NOT NULL DEFAULT 'image/png',
    fetched_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
