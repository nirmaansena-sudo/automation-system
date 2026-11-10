-- When an architect's home pin last moved, how far, and who moved it. Travel
-- approvals flag trips that start from a recently moved home pin.
ALTER TABLE architect_locations ADD COLUMN home_changed_at TEXT;
ALTER TABLE architect_locations ADD COLUMN home_moved_km REAL;
ALTER TABLE architect_locations ADD COLUMN home_changed_by TEXT;
