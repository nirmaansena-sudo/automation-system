-- MFA material is never returned by the user or generic data APIs.
CREATE TABLE account_security (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  secret TEXT NOT NULL,
  last_counter INTEGER NOT NULL DEFAULT -1,
  recovery_hashes TEXT NOT NULL DEFAULT '[]',
  enabled_at TEXT NOT NULL
);
