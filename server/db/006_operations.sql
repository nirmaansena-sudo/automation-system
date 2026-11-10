CREATE TABLE purchase_orders (
  id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  material TEXT NOT NULL, unit TEXT NOT NULL, supplier TEXT NOT NULL,
  quantity_milli INTEGER NOT NULL CHECK(quantity_milli>0),
  unit_cost_paise INTEGER NOT NULL CHECK(unit_cost_paise>=0),
  received_milli INTEGER NOT NULL DEFAULT 0 CHECK(received_milli>=0 AND received_milli<=quantity_milli),
  consumed_milli INTEGER NOT NULL DEFAULT 0 CHECK(consumed_milli>=0 AND consumed_milli<=received_milli),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  expense_id INTEGER UNIQUE REFERENCES expense_claims(id),
  note TEXT, created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_purchase_project ON purchase_orders(project_id,status);
CREATE TABLE stock_movements (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES purchase_orders(id),
  kind TEXT NOT NULL CHECK(kind IN ('receive','consume')),
  quantity_milli INTEGER NOT NULL CHECK(quantity_milli>0), cost_paise INTEGER NOT NULL DEFAULT 0,
  reference TEXT NOT NULL, note TEXT, actor_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_stock_reference ON stock_movements(order_id,kind,reference);
CREATE TABLE project_budgets (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id), amount_paise INTEGER NOT NULL CHECK(amount_paise>=0),
  revision INTEGER NOT NULL DEFAULT 1, note TEXT, updated_by INTEGER NOT NULL REFERENCES users(id), updated_at TEXT NOT NULL
);
CREATE TABLE project_external_costs (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
  category TEXT NOT NULL CHECK(category IN ('labour','subcontractor','equipment','overhead','other')),
  amount_paise INTEGER NOT NULL CHECK(amount_paise>0),
  reference TEXT NOT NULL, note TEXT NOT NULL,
  cost_date TEXT NOT NULL, created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
  UNIQUE(project_id,reference)
);
CREATE TABLE operation_events (
  client_event_id TEXT PRIMARY KEY, action TEXT NOT NULL, request_hash TEXT NOT NULL,
  result TEXT NOT NULL, created_at TEXT NOT NULL
);
