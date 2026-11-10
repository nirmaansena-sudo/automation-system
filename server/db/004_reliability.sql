ALTER TABLE routine_runs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE routine_runs ADD COLUMN next_attempt_at TEXT;
ALTER TABLE timers ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE timers ADD COLUMN next_attempt_at TEXT;
CREATE INDEX idx_routine_retry ON routine_runs(status, next_attempt_at);
