"""Generates the importable n8n workflows in n8n/workflows/.
Run: python3 scripts/build-n8n.py   (the JSON files are committed, this is only for maintainers)."""
import json, uuid, os

OUT = os.path.join(os.path.dirname(__file__), '..', 'n8n', 'workflows')
os.makedirs(OUT, exist_ok=True)
NS = uuid.UUID('6f1c2b7a-0d4e-4c3a-9a51-3b8e2f6d9c10')
def nid(wf, name): return str(uuid.uuid5(NS, f'{wf}:{name}'))

ENV_URL = "={{ $env.NS_BACKEND_URL }}"
KEY_HEADER = {"parameters": [{"name": "X-Automation-Key", "value": "={{ $env.NS_AUTOMATION_KEY }}"}]}

class WF:
    def __init__(self, key, name):
        self.key, self.name, self.nodes, self.conn = key, name, [], {}
    def node(self, name, type_, version, params, pos, **extra):
        n = {"parameters": params, "id": nid(self.key, name), "name": name, "type": type_, "typeVersion": version, "position": pos}
        n.update(extra)
        self.nodes.append(n)
        return name
    def link(self, a, b, out=0):
        self.conn.setdefault(a, {"main": []})
        while len(self.conn[a]["main"]) <= out: self.conn[a]["main"].append([])
        self.conn[a]["main"][out].append({"node": b, "type": "main", "index": 0})
    def note(self, name, text, pos, w=420, h=260, color=4):
        self.node(name, "n8n-nodes-base.stickyNote", 1, {"content": text, "height": h, "width": w, "color": color}, pos)
    def save(self, fname):
        wf = {"name": self.name, "nodes": self.nodes, "connections": self.conn, "pinData": {},
              "settings": {"executionOrder": "v1", "timezone": "Asia/Kolkata", "saveManualExecutions": True, "callerPolicy": "workflowsFromSameOwner"},
              "tags": [], "meta": {"templateCredsSetupCompleted": True}, "active": False}
        with open(os.path.join(OUT, fname), 'w', encoding='utf-8') as f: json.dump(wf, f, indent=2, ensure_ascii=False)

def http_post(path, timeout=60000):
    return {"method": "POST", "url": f"{ENV_URL}{path}", "sendHeaders": True, "headerParameters": KEY_HEADER, "options": {"timeout": timeout}}

# ---------------------------------------------------------------- 01 AI understanding
w = WF('ai', 'NS 01 · AI understanding (WhatsApp messages)')
w.note('About this workflow', "## AI understanding\nThe backend calls this webhook when `AI_MODE=n8n`. It sends the customer's message plus a ready-made prompt. This workflow asks your AI model and returns JSON (intent, area, plot size…).\n\n**The AI never writes to customers.** If anything fails, the backend falls back to buttons + keyword rules.\n\nSet in n8n's environment: `NS_AI_BASE_URL` (OpenAI-compatible, e.g. https://api.openai.com/v1), `NS_AI_API_KEY`, `NS_AI_MODEL`, `NS_N8N_SECRET`.\n\nEdit *Build AI request* to add your own instructions.", [-60, -280], 520, 300)
w.node('Webhook from backend', 'n8n-nodes-base.webhook', 2, {"httpMethod": "POST", "path": "ns-ai-understand", "responseMode": "responseNode", "options": {}}, [0, 100], webhookId=nid('ai', 'hook'))
w.node('Check secret & build AI request', 'n8n-nodes-base.code', 2, {"jsCode": """// Reject calls that do not carry the shared secret.
const req = $input.first().json;
const secret = (req.headers || {})['x-ns-secret'];
if (!secret || secret !== $env.NS_N8N_SECRET) {
  throw new Error('Unauthorised call to AI workflow');
}
const p = req.body.prompt || {};
// Add your own rules below (e.g. local area names, product words).
const extra = '\\nAlways answer with a single JSON object.';
return [{ json: {
  model: $env.NS_AI_MODEL || 'gpt-4o-mini',
  messages: [
    { role: 'system', content: (p.system || '') + extra },
    { role: 'user', content: p.user || '' },
  ],
  response_format: { type: 'json_object' },
} }];"""}, [260, 100])
w.node('Ask AI model', 'n8n-nodes-base.httpRequest', 4.2, {"method": "POST", "url": "={{ ($env.NS_AI_BASE_URL || 'https://api.openai.com/v1') + '/chat/completions' }}", "sendHeaders": True, "headerParameters": {"parameters": [{"name": "Authorization", "value": "={{ 'Bearer ' + $env.NS_AI_API_KEY }}"}]}, "sendBody": True, "specifyBody": "json", "jsonBody": "={{ JSON.stringify($json) }}", "options": {"timeout": 8000}}, [520, 100], onError='continueRegularOutput')
w.node('Parse answer', 'n8n-nodes-base.code', 2, {"jsCode": """// Turn the model's reply into the JSON the backend expects.
const r = $input.first().json || {};
const text = r.choices?.[0]?.message?.content || (r.content || []).map((c) => c.text || '').join('') || '';
let out = { intent: 'other', confidence: 0 };
const s = text.indexOf('{'); const e = text.lastIndexOf('}');
if (s >= 0 && e > s) { try { out = JSON.parse(text.slice(s, e + 1)); } catch (err) { out = { intent: 'other', confidence: 0 }; } }
return [{ json: out }];"""}, [780, 100])
w.node('Reply to backend', 'n8n-nodes-base.respondToWebhook', 1.1, {"respondWith": "json", "responseBody": "={{ JSON.stringify($json) }}", "options": {}}, [1040, 100])
w.link('Webhook from backend', 'Check secret & build AI request'); w.link('Check secret & build AI request', 'Ask AI model'); w.link('Ask AI model', 'Parse answer'); w.link('Parse answer', 'Reply to backend')
w.save('01-ai-understanding.json')

# ---------------------------------------------------------------- 02 Scheduled routines
w = WF('routines', 'NS 02 · Scheduled routines (daily & monthly)')
w.note('About this workflow', "## Scheduled routines\nEach trigger asks the backend to run one routine. The backend does the work in one database transaction and refuses to run the same routine twice for the same day, so it is safe to click *Execute* any time.\n\nTimes are India time (workflow timezone Asia/Kolkata). Change a time by opening its trigger.\n\nSet `ROUTINES_MODE=n8n` in the backend `.env` once this workflow is **published**. If n8n misses a run, the backend runs it 20 minutes later and tells you.", [-80, -360], 560, 300)
routines = [
    ('Every day 08:30', '30 8 * * *', 'manager-morning-brief', 'Manager morning brief'),
    ('Every day 10:15', '15 10 * * *', 'attendance-morning', 'Attendance – not checked in'),
    ('Every day 10:30', '30 10 * * *', 'payment-reminders', 'Payment reminders'),
    ('Every day 11:00', '0 11 * * *', 'lead-followups', 'Lead nudges & quote expiry'),
    ('Every day 19:00', '0 19 * * *', 'daily-site-digest', 'Daily client site update'),
    ('Every day 21:00', '0 21 * * *', 'attendance-evening', 'Attendance – missing check-out'),
    ('Every day 02:00', '0 2 * * *', 'backup', 'Database backup'),
    ('1st of month 09:00', '0 9 1 * *', 'monthly-summary', 'Monthly payroll summary'),
]
for i, (trig, cron, routine, label) in enumerate(routines):
    y = i * 160
    t = w.node(trig, 'n8n-nodes-base.scheduleTrigger', 1.2, {"rule": {"interval": [{"field": "cronExpression", "expression": cron}]}}, [0, y])
    h = w.node(f'Run: {label}', 'n8n-nodes-base.httpRequest', 4.2, http_post(f'/api/automation/routines/{routine}/run'), [300, y], retryOnFail=True, maxTries=3, waitBetweenTries=5000)
    w.link(t, h)
w.save('02-scheduled-routines.json')

# ---------------------------------------------------------------- 03 Business events
w = WF('events', 'NS 03 · Business events (email / Sheets / CRM)')
w.note('About this workflow', "## Business events\nThe backend posts every important event here (new enquiry, visit confirmed, project created, payment recorded, invoice issued, ticket, morning brief, payroll summary). The webhook responds only after all enabled steps finish. Failures return an error so the backend retries. Every event includes a stable eventId and Idempotency-Key: connected systems must deduplicate before applying effects. A timeout after partial success can replay earlier steps. Email delivery is not exactly-once.\n\nAdd your own steps after **Format event**: email the owner, append a row to Google Sheets, post to Slack/Telegram, or call your CRM. Two disabled examples are included — add credentials, then enable them.", [-60, -340], 560, 280)
w.node('Webhook: events from backend', 'n8n-nodes-base.webhook', 2, {"httpMethod": "POST", "path": "ns-events", "responseMode": "lastNode", "options": {}}, [0, 100], webhookId=nid('events', 'hook'))
w.node('Format event', 'n8n-nodes-base.code', 2, {"jsCode": """const req = $input.first().json;
if (!(req.headers || {})['x-ns-secret'] || (req.headers || {})['x-ns-secret'] !== $env.NS_N8N_SECRET) throw new Error('Unauthorised event');
const ev = req.body || {};
const d = ev.data || {};
const titles = {
  'lead.submitted': `New enquiry ${d.ref} (${(d.services || []).join(', ')}) — ${d.zone || ''}`,
  'visit.confirmed': `Site visit ${d.ref} confirmed: ${d.architect} at ${d.start}`,
  'visit.report_submitted': `Site report ${d.ref} submitted for ${d.leadRef}`,
  'quotation.sent': `Quotation ${d.ref} v${d.version} sent (₹${d.total})`,
  'project.created': `🎉 New project ${d.ref} for ${d.client} (₹${d.value})`,
  'payment.recorded': `Payment ₹${d.amount} received for ${d.project}`,
  'invoice.issued': `Invoice ${d.ref} issued for ${d.project}: ₹${d.amount}`,
  'milestone.accepted': `Stage “${d.milestone}” accepted on ${d.project}`,
  'ticket.created': `Client ticket ${d.ref} (${d.category})`,
  'brief.morning': `Morning brief: ${d.newLeads} new leads, ${d.visitsToday} visits today, ${d.pendingApprovals} approvals waiting`,
  'payroll.summary': `Payroll summary ready for ${d.month}`,
};
const important = ['lead.submitted', 'project.created', 'payment.recorded', 'ticket.created', 'brief.morning', 'payroll.summary'].includes(ev.type);
return [{ json: { eventId: ev.eventId || (req.headers || {})['idempotency-key'], type: ev.type, at: ev.at, title: titles[ev.type] || ev.type, important, data: d } }];"""}, [260, 100])
w.node('Important?', 'n8n-nodes-base.if', 2, {"conditions": {"options": {"caseSensitive": True, "leftValue": "", "typeValidation": "strict"}, "conditions": [{"id": nid('events', 'cond'), "leftValue": "={{ $json.important }}", "rightValue": True, "operator": {"type": "boolean", "operation": "true", "singleValue": True}}], "combinator": "and"}, "options": {}}, [520, 100])
w.node('Email the owner (add SMTP, then enable)', 'n8n-nodes-base.emailSend', 2.1, {"fromEmail": "automation@nirmaansena.com", "toEmail": "contact@nirmaansena.com", "subject": "={{ $json.title }}", "emailFormat": "text", "text": "={{ $json.title }}\n\n{{ JSON.stringify($json.data, null, 2) }}", "options": {}}, [800, 0], disabled=True, notesInFlow=True, notes='Create an SMTP credential (e.g. Gmail app password), select it here and enable the node.')
w.node('Send to your sheet / CRM (enable)', 'n8n-nodes-base.httpRequest', 4.2, {"method": "POST", "url": "https://script.google.com/macros/s/YOUR-APPS-SCRIPT-ID/exec", "sendBody": True, "specifyBody": "json", "jsonBody": "={{ JSON.stringify({ eventId: $json.eventId, type: $json.type, at: $json.at, title: $json.title, data: $json.data }) }}", "options": {"timeout": 15000}}, [800, 200], disabled=True, notesInFlow=True, notes='Example: a Google Apps Script web app that appends rows to a Google Sheet. Replace the URL, then enable.')
w.node('Other events (no action)', 'n8n-nodes-base.noOp', 1, {}, [800, 360])
w.link('Webhook: events from backend', 'Format event'); w.link('Format event', 'Important?')
w.link('Important?', 'Email the owner (add SMTP, then enable)', 0); w.link('Important?', 'Send to your sheet / CRM (enable)', 0); w.link('Important?', 'Other events (no action)', 1)
w.save('03-business-events.json')

# ---------------------------------------------------------------- 04 Error alerts
w = WF('errors', 'NS 04 · Error alerts (set as Error Workflow)')
w.note('About this workflow', "## Error alerts\nIf any n8n workflow fails, this one tells the owner in the dashboard (bell icon) and, once enabled, by email.\n\n**Setup:** open each NS workflow → *Settings* → *Error workflow* → choose this workflow.", [-60, -300], 480, 220)
w.node('When a workflow fails', 'n8n-nodes-base.errorTrigger', 1, {}, [0, 100])
w.node('Alert in dashboard', 'n8n-nodes-base.httpRequest', 4.2, {**http_post('/api/automation/alerts', 15000), "sendBody": True, "specifyBody": "json", "jsonBody": "={{ JSON.stringify({ title: 'n8n workflow failed: ' + ($json.workflow?.name || 'unknown'), body: ($json.execution?.error?.message || 'No message') + ' (execution ' + ($json.execution?.id || '?') + ')', level: 'error' }) }}"}, [280, 0], retryOnFail=True, maxTries=3, waitBetweenTries=5000)
w.node('Email the owner (add SMTP, then enable)', 'n8n-nodes-base.emailSend', 2.1, {"fromEmail": "automation@nirmaansena.com", "toEmail": "contact@nirmaansena.com", "subject": "={{ 'n8n failed: ' + ($json.workflow?.name || '') }}", "emailFormat": "text", "text": "={{ $json.execution?.error?.message || '' }}", "options": {}}, [280, 200], disabled=True)
w.link('When a workflow fails', 'Alert in dashboard'); w.link('When a workflow fails', 'Email the owner (add SMTP, then enable)')
w.save('04-error-alerts.json')

# ---------------------------------------------------------------- 05 Health watchdog
w = WF('watchdog', 'NS 05 · Health watchdog (every 15 min)')
w.note('About this workflow', "## Health watchdog\nEvery 15 minutes n8n checks the backend: outgoing WhatsApp queue, stuck incoming messages, timers, scheduler and failed routines. The backend also shows when n8n was last seen — each watches the other.\n\nIf the backend is **down**, the dashboard cannot show alerts, so enable the email node (or add Telegram/SMS).", [-60, -320], 520, 240)
w.node('Every 15 minutes', 'n8n-nodes-base.scheduleTrigger', 1.2, {"rule": {"interval": [{"field": "minutes", "minutesInterval": 15}]}}, [0, 100])
w.node('Check backend health', 'n8n-nodes-base.httpRequest', 4.2, {"method": "GET", "url": f"{ENV_URL}/api/automation/health", "sendHeaders": True, "headerParameters": KEY_HEADER, "options": {"timeout": 15000}}, [240, 100], onError='continueRegularOutput')
w.node('Evaluate', 'n8n-nodes-base.code', 2, {"jsCode": """const r = $input.first().json || {};
if (r.error || r.ok === undefined) {
  return [{ json: { problem: true, down: true, message: 'Backend not reachable: ' + (r.error?.message || r.message || 'no response') } }];
}
return [{ json: { problem: !r.ok, down: false, message: (r.warnings || []).join('; ') } }];"""}, [480, 100])
w.node('Problem?', 'n8n-nodes-base.if', 2, {"conditions": {"options": {"caseSensitive": True, "leftValue": "", "typeValidation": "strict"}, "conditions": [{"id": nid('watchdog', 'cond'), "leftValue": "={{ $json.problem }}", "rightValue": True, "operator": {"type": "boolean", "operation": "true", "singleValue": True}}], "combinator": "and"}, "options": {}}, [720, 100])
w.node('Email the owner (add SMTP, then enable)', 'n8n-nodes-base.emailSend', 2.1, {"fromEmail": "automation@nirmaansena.com", "toEmail": "contact@nirmaansena.com", "subject": "={{ $json.down ? '🚨 Nirmaan Sena system is DOWN' : '⚠ Nirmaan Sena system needs attention' }}", "emailFormat": "text", "text": "={{ $json.message }}", "options": {}}, [980, 0], disabled=True)
w.node('All good', 'n8n-nodes-base.noOp', 1, {}, [980, 220])
w.link('Every 15 minutes', 'Check backend health'); w.link('Check backend health', 'Evaluate'); w.link('Evaluate', 'Problem?')
w.link('Problem?', 'Email the owner (add SMTP, then enable)', 0); w.link('Problem?', 'All good', 1)
w.save('05-health-watchdog.json')
print('written to', os.path.abspath(OUT))
