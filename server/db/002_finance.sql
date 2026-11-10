ALTER TABLE payments ADD COLUMN client_event_id TEXT;
ALTER TABLE payments ADD COLUMN normalized_reference TEXT;
CREATE UNIQUE INDEX payments_event_key ON payments(client_event_id) WHERE client_event_id IS NOT NULL;
CREATE UNIQUE INDEX payments_reference_key ON payments(invoice_id, method, normalized_reference) WHERE normalized_reference IS NOT NULL;
ALTER TABLE invoices ADD COLUMN original_amount REAL;
ALTER TABLE projects ADD COLUMN require_payment_before_handover INTEGER NOT NULL DEFAULT 0;
CREATE TABLE credit_notes (
  id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  change_request_id INTEGER UNIQUE REFERENCES change_requests(id),
  amount REAL NOT NULL CHECK(amount > 0), reason TEXT NOT NULL,
  allocations TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE refunds (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
  amount REAL NOT NULL CHECK(amount > 0), method TEXT NOT NULL, reference TEXT NOT NULL,
  client_event_id TEXT NOT NULL UNIQUE, recorded_by INTEGER, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX refunds_reference_key ON refunds(project_id, method, reference);
CREATE TABLE reconciliations (
  id INTEGER PRIMARY KEY, payment_id INTEGER NOT NULL UNIQUE REFERENCES payments(id),
  statement_reference TEXT NOT NULL, note TEXT, reconciled_by INTEGER, reconciled_at TEXT NOT NULL
);
