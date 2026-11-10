-- Nirmaan Sena — core schema (SQLite). Times are ISO-8601 UTC strings.

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0);

-- Staff (dashboard users + employees + architects share one table)
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT UNIQUE,
  email TEXT UNIQUE,
  role TEXT NOT NULL,                 -- owner | manager | architect | engineer | supervisor | staff | finance
  title TEXT,
  password_hash TEXT,
  pin_hash TEXT,
  zones TEXT NOT NULL DEFAULT '[]',
  skills TEXT NOT NULL DEFAULT '[]',
  shift_start TEXT NOT NULL DEFAULT '09:00',
  shift_end TEXT NOT NULL DEFAULT '18:00',
  grace_min INTEGER NOT NULL DEFAULT 15,
  weekly_off TEXT NOT NULL DEFAULT '[0]',
  daily_visit_cap INTEGER NOT NULL DEFAULT 3,
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, expires_at TEXT NOT NULL,
  created_at TEXT, last_seen_at TEXT, ip TEXT, ua TEXT
);

CREATE TABLE zones (code TEXT PRIMARY KEY, name TEXT NOT NULL, name_hi TEXT, lat REAL, lng REAL, active INTEGER NOT NULL DEFAULT 1, sort INTEGER DEFAULT 0);
CREATE TABLE holidays (day TEXT PRIMARY KEY, name TEXT);
CREATE TABLE faqs (id INTEGER PRIMARY KEY, question TEXT NOT NULL, answer_en TEXT NOT NULL, answer_hi TEXT, keywords TEXT, active INTEGER NOT NULL DEFAULT 1, updated_at TEXT);

-- WhatsApp contacts and conversations
CREATE TABLE contacts (
  id INTEGER PRIMARY KEY,
  wa_id TEXT NOT NULL UNIQUE,
  name TEXT, profile_name TEXT, email TEXT,
  kind TEXT NOT NULL DEFAULT 'client',  -- client | staff | vendor | job_seeker | spam
  user_id INTEGER REFERENCES users(id),
  language TEXT NOT NULL DEFAULT 'en',
  opted_out INTEGER NOT NULL DEFAULT 0, opted_out_at TEXT,
  consent_at TEXT,
  last_inbound_at TEXT, last_outbound_at TEXT,
  tags TEXT NOT NULL DEFAULT '[]', notes TEXT,
  erased_at TEXT,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE conversations (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL UNIQUE REFERENCES contacts(id),
  mode TEXT NOT NULL DEFAULT 'bot',      -- bot | human
  owner_user_id INTEGER REFERENCES users(id), owner_until TEXT, human_requested_at TEXT,
  flow TEXT, step TEXT, ctx TEXT NOT NULL DEFAULT '{}',
  awaiting_since TEXT, nudges INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0, needs_attention INTEGER NOT NULL DEFAULT 0, attention_reason TEXT,
  last_message_at TEXT, last_message_preview TEXT,
  bot_window_start TEXT, bot_window_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);
CREATE INDEX idx_conv_last ON conversations(last_message_at);

-- Durable inbox of raw webhook events
CREATE TABLE inbound_events (
  id INTEGER PRIMARY KEY,
  provider TEXT, kind TEXT NOT NULL,     -- message | status | echo | form
  dedupe_key TEXT NOT NULL UNIQUE,
  wa_id TEXT, payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | processing | done | failed | ignored
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  received_at TEXT, locked_at TEXT, processed_at TEXT
);
CREATE INDEX idx_inbound_status ON inbound_events(status, id);
CREATE INDEX idx_inbound_wa ON inbound_events(wa_id, status);

CREATE TABLE media (
  id INTEGER PRIMARY KEY, provider_media_id TEXT, mime TEXT, file_path TEXT, size INTEGER, sha256 TEXT,
  caption TEXT, owner_type TEXT, owner_id INTEGER, uploaded_by TEXT, lat REAL, lng REAL,
  status TEXT NOT NULL DEFAULT 'stored', created_at TEXT
);
CREATE INDEX idx_media_owner ON media(owner_type, owner_id);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  direction TEXT NOT NULL,               -- in | out
  wamid TEXT, type TEXT, body TEXT, payload TEXT,
  media_id INTEGER REFERENCES media(id),
  sender TEXT,                           -- client | bot | user:<id> | system | app
  status TEXT, outbox_id INTEGER, error TEXT, category TEXT, route TEXT,
  created_at TEXT, status_at TEXT
);
CREATE INDEX idx_messages_contact ON messages(contact_id, id);
CREATE INDEX idx_messages_wamid ON messages(wamid);

CREATE TABLE outbox (
  id INTEGER PRIMARY KEY,
  channel TEXT NOT NULL DEFAULT 'whatsapp',  -- whatsapp | n8n
  to_wa_id TEXT, contact_id INTEGER,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  template TEXT,
  essential INTEGER NOT NULL DEFAULT 0,
  sender TEXT,
  guard TEXT,
  status TEXT NOT NULL DEFAULT 'queued',   -- queued | sending | sent | unknown | failed | cancelled | needs_operator
  attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 6,
  next_attempt_at TEXT, lease_until TEXT,
  wamid TEXT, route TEXT, last_error TEXT, error_code TEXT,
  dedupe_key TEXT UNIQUE,
  created_at TEXT, sent_at TEXT, updated_at TEXT
);
CREATE INDEX idx_outbox_due ON outbox(status, next_attempt_at);
CREATE INDEX idx_outbox_to ON outbox(to_wa_id, id);

CREATE TABLE wa_templates (
  name TEXT NOT NULL, language TEXT NOT NULL, category TEXT NOT NULL,
  body TEXT NOT NULL, params TEXT NOT NULL DEFAULT '[]', buttons TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft',   -- draft | submitted | approved | rejected
  updated_at TEXT, PRIMARY KEY (name, language)
);

-- Sales pipeline
CREATE TABLE leads (
  id INTEGER PRIMARY KEY, ref TEXT UNIQUE,
  contact_id INTEGER REFERENCES contacts(id), source TEXT NOT NULL DEFAULT 'whatsapp',
  status TEXT NOT NULL DEFAULT 'capturing',
  name TEXT, phone TEXT,
  zone TEXT, locality TEXT, address TEXT, site_lat REAL, site_lng REAL, location_source TEXT,
  services TEXT NOT NULL DEFAULT '[]', project_nature TEXT, area_sqft REAL, area_text TEXT,
  execution_window TEXT, preferred_slots TEXT NOT NULL DEFAULT '[]', requirements TEXT,
  priority TEXT NOT NULL DEFAULT 'normal', owner_id INTEGER REFERENCES users(id),
  lost_reason TEXT, project_id INTEGER, ai_summary TEXT, consent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT, updated_at TEXT, submitted_at TEXT, qualified_at TEXT, first_response_at TEXT
);
CREATE INDEX idx_leads_status ON leads(status);
CREATE INDEX idx_leads_contact ON leads(contact_id);

-- Unified human-decision queue
CREATE TABLE approvals (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL,
  entity_type TEXT, entity_id INTEGER, title TEXT, summary TEXT, data TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected | cancelled | done
  requested_by TEXT, decided_by INTEGER, decision TEXT, decision_note TEXT,
  due_at TEXT, escalated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT, decided_at TEXT
);
CREATE INDEX idx_approvals_status ON approvals(status, kind);
CREATE INDEX idx_approvals_entity ON approvals(entity_type, entity_id);

-- Architect scheduling
CREATE TABLE visit_offers (
  id INTEGER PRIMARY KEY, lead_id INTEGER NOT NULL REFERENCES leads(id), architect_id INTEGER NOT NULL REFERENCES users(id),
  revision INTEGER NOT NULL, attempt INTEGER NOT NULL DEFAULT 1,
  slot_start TEXT NOT NULL, slot_end TEXT NOT NULL,
  status TEXT NOT NULL,   -- pending | accepted | declined | expired | cancelled | superseded | client_confirmed | client_declined | client_timeout
  expires_at TEXT, responded_at TEXT, decline_reason TEXT, client_deadline TEXT, hold_id INTEGER,
  created_by TEXT, created_at TEXT, updated_at TEXT
);
CREATE INDEX idx_offers_lead ON visit_offers(lead_id, revision);
CREATE TABLE calendar_holds (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  start_at TEXT NOT NULL, end_at TEXT NOT NULL,
  kind TEXT NOT NULL,           -- hold | visit | leave | block
  ref_type TEXT, ref_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active', expires_at TEXT, created_at TEXT
);
CREATE INDEX idx_holds_user ON calendar_holds(user_id, status, start_at);
CREATE TABLE visits (
  id INTEGER PRIMARY KEY, ref TEXT UNIQUE, lead_id INTEGER REFERENCES leads(id), project_id INTEGER,
  architect_id INTEGER REFERENCES users(id), offer_id INTEGER, hold_id INTEGER,
  revision INTEGER NOT NULL DEFAULT 1, start_at TEXT NOT NULL, end_at TEXT NOT NULL,
  status TEXT NOT NULL,   -- confirmed | in_progress | report_submitted | completed | no_show_client | no_show_architect | cancelled
  checkin_at TEXT, checkin_lat REAL, checkin_lng REAL, checkin_distance_m REAL, checkout_at TEXT,
  report TEXT, report_at TEXT, review_status TEXT, review_note TEXT,
  cancel_reason TEXT, created_at TEXT, updated_at TEXT
);
CREATE INDEX idx_visits_start ON visits(start_at);

-- Quotations and projects
CREATE TABLE quotations (
  id INTEGER PRIMARY KEY, ref TEXT, lead_id INTEGER REFERENCES leads(id), project_id INTEGER, version INTEGER NOT NULL,
  service_type TEXT, commercial_model TEXT,
  items TEXT NOT NULL DEFAULT '[]', subtotal REAL, gst_pct REAL NOT NULL DEFAULT 18, total REAL,
  payment_schedule TEXT NOT NULL DEFAULT '[]', notes TEXT, valid_until TEXT,
  status TEXT NOT NULL DEFAULT 'draft',  -- draft | pending_approval | approved | sent | accepted | revision_requested | rejected | expired | superseded
  public_token TEXT UNIQUE, client_note TEXT,
  created_by INTEGER, approved_by INTEGER, created_at TEXT, sent_at TEXT, decided_at TEXT, updated_at TEXT
);
CREATE INDEX idx_quotes_lead ON quotations(lead_id, version);
CREATE TABLE projects (
  id INTEGER PRIMARY KEY, ref TEXT UNIQUE, name TEXT, lead_id INTEGER REFERENCES leads(id),
  client_contact_id INTEGER REFERENCES contacts(id), client_name TEXT, client_phone TEXT,
  zone TEXT, address TEXT, site_lat REAL, site_lng REAL, geofence_m INTEGER NOT NULL DEFAULT 250,
  service_type TEXT, commercial_model TEXT, area_sqft REAL,
  contract_value REAL, quotation_id INTEGER, baseline_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'awaiting_advance', -- awaiting_advance | active | on_hold | handover | warranty | closed | cancelled
  manager_id INTEGER, architect_id INTEGER, supervisor_id INTEGER, engineer_id INTEGER,
  start_date TEXT, target_end TEXT, handover_at TEXT, warranty_until TEXT,
  public_token TEXT UNIQUE, portfolio_consent INTEGER NOT NULL DEFAULT 0, digest_enabled INTEGER NOT NULL DEFAULT 1,
  authorized_phones TEXT NOT NULL DEFAULT '[]', notes TEXT,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE milestones (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), seq INTEGER NOT NULL, name TEXT NOT NULL,
  baseline_version INTEGER NOT NULL DEFAULT 1, planned_start TEXT, planned_end TEXT,
  pay_pct REAL NOT NULL DEFAULT 0, amount REAL NOT NULL DEFAULT 0, needs_site_work INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'planned', -- planned | in_progress | ready_for_review | rework | client_review | accepted | invoiced | paid | cancelled
  progress INTEGER NOT NULL DEFAULT 0, review_note TEXT, reviewed_by INTEGER, client_signoff_at TEXT, client_note TEXT,
  completed_at TEXT, created_at TEXT, updated_at TEXT
);
CREATE INDEX idx_ms_project ON milestones(project_id, seq);
CREATE TABLE site_logs (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), user_id INTEGER REFERENCES users(id),
  log_date TEXT NOT NULL, work_done TEXT, labour TEXT NOT NULL DEFAULT '{}', materials TEXT, issues TEXT,
  milestone_id INTEGER, progress INTEGER, lat REAL, lng REAL, distance_m REAL,
  client_visible INTEGER NOT NULL DEFAULT 1, digest_sent_at TEXT, client_event_id TEXT UNIQUE,
  device_time TEXT, created_at TEXT
);
CREATE INDEX idx_logs_project ON site_logs(project_id, log_date);
CREATE TABLE invoices (
  id INTEGER PRIMARY KEY, ref TEXT UNIQUE, project_id INTEGER NOT NULL REFERENCES projects(id), milestone_id INTEGER,
  title TEXT, amount REAL NOT NULL, due_date TEXT,
  status TEXT NOT NULL DEFAULT 'issued', -- issued | partially_paid | paid | cancelled
  paid_amount REAL NOT NULL DEFAULT 0, payment_link TEXT,
  reminders INTEGER NOT NULL DEFAULT 0, last_reminder_at TEXT,
  issued_at TEXT, paid_at TEXT, created_at TEXT
);
CREATE TABLE payments (
  id INTEGER PRIMARY KEY, invoice_id INTEGER REFERENCES invoices(id), project_id INTEGER REFERENCES projects(id),
  amount REAL NOT NULL, method TEXT, reference TEXT, received_at TEXT, recorded_by INTEGER, created_at TEXT
);
CREATE TABLE change_requests (
  id INTEGER PRIMARY KEY, ref TEXT, project_id INTEGER NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL, description TEXT, requested_by TEXT,
  cost_impact REAL NOT NULL DEFAULT 0, days_impact INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending_manager', -- pending_manager | pending_client | approved | rejected | applied
  new_baseline_version INTEGER, created_at TEXT, decided_at TEXT
);
CREATE TABLE tickets (
  id INTEGER PRIMARY KEY, ref TEXT UNIQUE, contact_id INTEGER REFERENCES contacts(id), project_id INTEGER REFERENCES projects(id),
  category TEXT, subject TEXT, description TEXT, priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'open', -- open | in_progress | waiting_client | resolved | closed
  assignee_id INTEGER REFERENCES users(id), due_at TEXT, first_response_at TEXT, resolved_at TEXT,
  created_at TEXT, updated_at TEXT
);

-- Work management
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT,
  assignee_id INTEGER REFERENCES users(id), created_by TEXT,
  entity_type TEXT, entity_id INTEGER, kind TEXT NOT NULL DEFAULT 'general',
  priority TEXT NOT NULL DEFAULT 'normal', status TEXT NOT NULL DEFAULT 'todo', -- todo | in_progress | blocked | done | cancelled
  due_at TEXT, completed_at TEXT, evidence TEXT, dedupe_key TEXT UNIQUE,
  created_at TEXT, updated_at TEXT
);
CREATE INDEX idx_tasks_assignee ON tasks(assignee_id, status);

CREATE TABLE attendance_events (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), kind TEXT NOT NULL, -- in | out
  device_time TEXT, server_time TEXT NOT NULL, effective_time TEXT NOT NULL, lat REAL, lng REAL, accuracy_m REAL,
  place_type TEXT, place_id INTEGER, place_name TEXT, distance_m REAL, photo_media_id INTEGER,
  client_event_id TEXT UNIQUE, offline INTEGER NOT NULL DEFAULT 0,
  validation TEXT NOT NULL, reasons TEXT NOT NULL DEFAULT '[]',
  review_status TEXT, reviewed_by INTEGER, review_note TEXT, reviewed_at TEXT, note TEXT, auto INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_att_user ON attendance_events(user_id, effective_time);
CREATE TABLE attendance_days (
  user_id INTEGER NOT NULL REFERENCES users(id), day TEXT NOT NULL,
  status TEXT NOT NULL, first_in TEXT, last_out TEXT, minutes INTEGER NOT NULL DEFAULT 0,
  flags TEXT NOT NULL DEFAULT '[]', updated_at TEXT,
  PRIMARY KEY (user_id, day)
);
CREATE TABLE leave_requests (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), type TEXT NOT NULL,
  from_date TEXT NOT NULL, to_date TEXT NOT NULL, reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending', decided_by INTEGER, decision_note TEXT, created_at TEXT, decided_at TEXT
);
CREATE TABLE expense_claims (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), category TEXT NOT NULL, amount REAL NOT NULL,
  claim_date TEXT, project_id INTEGER, description TEXT, receipt_media_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending_manager', -- pending_manager | pending_finance | approved | rejected | paid
  manager_id INTEGER, manager_at TEXT, finance_id INTEGER, finance_at TEXT, note TEXT, created_at TEXT
);

-- Engine plumbing
CREATE TABLE timers (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, entity_type TEXT, entity_id INTEGER, revision INTEGER,
  due_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', data TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT UNIQUE, created_at TEXT, fired_at TEXT, result TEXT
);
CREATE INDEX idx_timers_due ON timers(status, due_at);
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), audience TEXT, title TEXT NOT NULL, body TEXT,
  link TEXT, level TEXT NOT NULL DEFAULT 'info', read_at TEXT, created_at TEXT
);
CREATE INDEX idx_notif_user ON notifications(user_id, read_at);
CREATE TABLE audit_log (id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT, action TEXT NOT NULL, entity_type TEXT, entity_id INTEGER, data TEXT);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE TABLE routine_runs (
  id INTEGER PRIMARY KEY, routine TEXT NOT NULL, run_key TEXT NOT NULL UNIQUE, trigger TEXT,
  status TEXT NOT NULL, result TEXT, started_at TEXT, finished_at TEXT
);
