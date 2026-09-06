CREATE TABLE device_settings (
	device_id TEXT PRIMARY KEY,
	auto_start_live_activity INTEGER NOT NULL DEFAULT 1,
	updated_at TEXT NOT NULL
);
