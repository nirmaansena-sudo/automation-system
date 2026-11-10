// Writes docs/TEMPLATES.md from server/whatsapp/templates.js (run: node scripts/build-templates-doc.js)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEMPLATES } from '../server/whatsapp/templates.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES = {
  'lead ref': 'NS-JPR-2026-0042', 'services': 'New house (turnkey)', 'area': 'Vaishali Nagar', 'proposed time': 'Sat, 8 Nov, 11:00 am', 'reply-by time': '3:30 pm',
  'client name': 'Deepak', 'architect': 'Ar. Rahul Mehta', 'time': 'Sat, 8 Nov, 11:00 am', 'visit ref': 'NS-VIS-2026-0017', 'client phone': '+91 98123 45678',
  'address': 'Plot 12, Gandhi Path, Vaishali Nagar', 'map link': 'https://www.google.com/maps/search/?api=1&query=26.91,75.74', 'place': 'Vaishali Nagar',
  'project ref': 'NS-PRJ-2026-004', 'summary': 'Brickwork 2nd floor 75%, 12 workers on site', 'link': 'https://ops.example.com/p/abc123', 'quote ref': 'NS-QT-2026-0011',
  'version': '2', 'service': 'Construction · Turnkey', 'total': '₹46,72,800', 'valid until': '17 Nov 2026', 'milestone': 'Roof slab', 'invoice ref': 'NS-INV-2026-0031',
  'amount': '₹7,00,920', 'for': 'Roof slab', 'due date': '20 Nov 2026', 'how to pay': 'Bank transfer / UPI details will be shared by our accounts team.',
  'booking amount': '₹4,67,280', 'change': 'Add balcony on first floor', 'cost impact': '₹85,000', 'time impact': '6 days', 'subject': 'NS-VIS-2026-0017',
  'update': 'our architect is running a little late', 'alert': 'site report pending for NS-VIS-2026-0017', 'name': 'Suresh', 'date': '2026-11-08',
};
let md = `# WhatsApp message templates\n\nWhatsApp only allows **pre-approved templates** when the person has not written to you in the last 24 hours\n(for example reminders, architect offers, daily updates and payment reminders). Everything else is sent as a\nnormal reply inside the 24-hour window.\n\n**How to submit:** WhatsApp Manager → *Message templates* → *Create template* → Category **Utility** →\nuse exactly the **name** below → language *English* (en) and again *Hindi* (hi) → paste the body →\nadd the buttons as **Quick reply** buttons → add the sample values → submit.\nWhen Meta approves a template, open the dashboard → *Messages → Templates* and set it to **approved**.\n\nRules already followed: no variable at the very start or end of the text, variables numbered in the order\nthey appear. Meta may still re-categorise a template; if one is rejected,\nshorten it slightly and resubmit.\n\nUntil a template is approved, the system creates a *“Send manually”* task instead of failing silently.\n\n| # | Template | Sent to | Buttons |\n|---|---|---|---|\n`;
TEMPLATES.forEach((t, i) => { md += `| ${i + 1} | \`${t.name}\` | ${t.to} | ${t.en.buttons.join(' · ') || '—'} |\n`; });
for (const t of TEMPLATES) {
  md += `\n---\n\n## \`${t.name}\`\n\nCategory: **${t.category}** · Sent to: ${t.to}\n\n`;
  md += `**Variables:** ${t.params.map((p, i) => `{{${i + 1}}} = ${p}`).join(' · ')}\n\n`;
  md += `**English (en)**\n\n> ${t.en.body}\n\n`;
  if (t.en.buttons.length) md += `Quick-reply buttons: ${t.en.buttons.map((b) => `\`${b}\``).join(', ')}\n\n`;
  md += `**Hindi (hi)**\n\n> ${t.hi.body}\n\n`;
  if (t.hi.buttons.length) md += `Quick-reply buttons: ${t.hi.buttons.map((b) => `\`${b}\``).join(', ')}\n\n`;
  md += `**Sample values for Meta's review:** ${t.params.map((p, i) => `{{${i + 1}}} \`${EXAMPLES[p] || p}\``).join(' · ')}\n`;
}
fs.writeFileSync(path.join(root, 'docs', 'TEMPLATES.md'), md);
console.log('docs/TEMPLATES.md written,', TEMPLATES.length, 'templates');
