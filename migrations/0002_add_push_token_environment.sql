CREATE TABLE push_tokens_new (
	id INTEGER PRIMARY KEY,
	device_id TEXT NOT NULL,
	token_type TEXT NOT NULL,
	scope_id TEXT NOT NULL DEFAULT '',
	token TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	environment TEXT NOT NULL DEFAULT 'production',
	UNIQUE(device_id, token_type, scope_id, environment)
);

INSERT INTO push_tokens_new (device_id, token_type, scope_id, token, updated_at, environment)
SELECT device_id, token_type, scope_id, token, updated_at, 'production' FROM push_tokens;

DROP TABLE push_tokens;

ALTER TABLE push_tokens_new RENAME TO push_tokens;
