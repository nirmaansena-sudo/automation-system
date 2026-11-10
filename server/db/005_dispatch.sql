-- Locations are separate from public staff records: never expose a colleague's home pin.
CREATE TABLE architect_locations (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  home_lat REAL, home_lng REAL, home_label TEXT,
  default_origin TEXT NOT NULL DEFAULT 'office' CHECK(default_origin IN ('office','home')),
  updated_at TEXT NOT NULL
);
CREATE TABLE route_cache (
  cache_key TEXT PRIMARY KEY, distance_km REAL NOT NULL, duration_min REAL,
  source TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE visit_travel (
  visit_id INTEGER PRIMARY KEY REFERENCES visits(id), user_id INTEGER NOT NULL REFERENCES users(id),
  visit_revision INTEGER NOT NULL, origin_type TEXT NOT NULL CHECK(origin_type IN ('home','office')),
  origin_lat REAL NOT NULL, origin_lng REAL NOT NULL, site_lat REAL NOT NULL, site_lng REAL NOT NULL,
  distance_km REAL NOT NULL, distance_source TEXT NOT NULL, duration_min REAL,
  amount REAL, policy TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'proposed',
  revision INTEGER NOT NULL DEFAULT 1, approved_by INTEGER REFERENCES users(id), approved_at TEXT,
  expense_id INTEGER UNIQUE REFERENCES expense_claims(id), note TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_travel_user ON visit_travel(user_id, status);
