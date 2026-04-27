CREATE TABLE IF NOT EXISTS vault_items (
    id                  TEXT PRIMARY KEY,
    item_type           TEXT NOT NULL CHECK (item_type IN ('card', 'address', 'passkey')),
    payload_encrypted   TEXT NOT NULL,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_vault_items_type ON vault_items(item_type);
