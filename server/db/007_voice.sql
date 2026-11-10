CREATE TABLE media_transcripts (
  media_id INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  status TEXT NOT NULL, language TEXT NOT NULL DEFAULT 'auto',
  text TEXT, original_text TEXT, error TEXT,
  requested_by INTEGER, reviewed_by INTEGER, reviewed_at TEXT,
  started_at TEXT NOT NULL, completed_at TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE compute_usage (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('ai','transcription')),
  day TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'reserved',
  provider TEXT, media_id INTEGER, duration_ms INTEGER,
  created_at TEXT NOT NULL, completed_at TEXT
);
CREATE INDEX compute_usage_day_kind ON compute_usage(day, kind);
CREATE INDEX compute_usage_created ON compute_usage(created_at);
