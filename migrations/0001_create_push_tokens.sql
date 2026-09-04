CREATE TABLE push_tokens (
	id INTEGER PRIMARY KEY,
	device_id TEXT NOT NULL,
	token_type TEXT NOT NULL,
	scope_id TEXT NOT NULL DEFAULT '',
	token TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	UNIQUE(device_id, token_type, scope_id)
);
