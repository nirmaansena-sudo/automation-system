// Provider-neutral message specs → WhatsApp Cloud API payloads, plus a text
// preview for the conversation log. Enforces WhatsApp's size limits.
const lim = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

/**
 * Spec types:
 *  {type:'text', text}
 *  {type:'buttons', text, header?, footer?, buttons:[{id,title}]}          (max 3)
 *  {type:'list', text, header?, footer?, button, sections:[{title, rows:[{id,title,description?}]}]} (max 10 rows)
 *  {type:'location', lat, lng, name?, address?}
 *  {type:'location_request', text}
 *  {type:'cta_url', text, display, url, header?, footer?}
 *  {type:'image', url, caption?}
 *  {type:'template', name, language, params:[...], buttons:[{type:'quick_reply', payload}|{type:'url', text}]}
 */
export function toCloudPayload(to, spec, callbackData) {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to };
  if (callbackData) base.biz_opaque_callback_data = String(callbackData).slice(0, 512);
  const header = spec.header ? { header: { type: 'text', text: lim(spec.header, 60) } } : {};
  const footer = spec.footer ? { footer: { text: lim(spec.footer, 60) } } : {};
  switch (spec.type) {
    case 'text':
      return { ...base, type: 'text', text: { body: lim(spec.text, 4096), preview_url: !!spec.previewUrl } };
    case 'buttons':
      return {
        ...base, type: 'interactive',
        interactive: {
          type: 'button', ...header, body: { text: lim(spec.text, 1024) }, ...footer,
          action: { buttons: spec.buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: lim(b.id, 256), title: lim(b.title, 20) } })) },
        },
      };
    case 'list': {
      let budget = 10;
      const sections = [];
      for (const s of spec.sections) {
        const rows = s.rows.slice(0, budget).map((r) => {
          const row = { id: lim(r.id, 200), title: lim(r.title, 24) };
          if (r.description) row.description = lim(r.description, 72);
          return row;
        });
        budget -= rows.length;
        if (rows.length) sections.push({ ...(s.title ? { title: lim(s.title, 24) } : {}), rows });
        if (budget <= 0) break;
      }
      if (sections.length > 1) sections.forEach((s, i) => { if (!s.title) s.title = `Options ${i + 1}`; });
      return {
        ...base, type: 'interactive',
        interactive: { type: 'list', ...header, body: { text: lim(spec.text, 4096) }, ...footer, action: { button: lim(spec.button || 'Choose', 20), sections } },
      };
    }
    case 'location':
      return { ...base, type: 'location', location: { latitude: Number(spec.lat), longitude: Number(spec.lng), ...(spec.name ? { name: lim(spec.name, 100) } : {}), ...(spec.address ? { address: lim(spec.address, 300) } : {}) } };
    case 'location_request':
      return { ...base, type: 'interactive', interactive: { type: 'location_request_message', body: { text: lim(spec.text, 1024) }, action: { name: 'send_location' } } };
    case 'cta_url':
      return {
        ...base, type: 'interactive',
        interactive: { type: 'cta_url', ...header, body: { text: lim(spec.text, 1024) }, ...footer, action: { name: 'cta_url', parameters: { display_text: lim(spec.display, 20), url: spec.url } } },
      };
    case 'image':
      return { ...base, type: 'image', image: { link: spec.url, ...(spec.caption ? { caption: lim(spec.caption, 1024) } : {}) } };
    case 'template': {
      const components = [];
      if (spec.params && spec.params.length) components.push({ type: 'body', parameters: spec.params.map((p) => ({ type: 'text', text: lim(String(p ?? '-').replace(/[\n\t]+/g, ' ').replace(/ {4,}/g, '   ') || '-', 1000) })) });
      (spec.buttons || []).forEach((b, i) => {
        if (b.type === 'quick_reply' && b.payload) components.push({ type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload: b.payload }] });
        if (b.type === 'url' && b.text) components.push({ type: 'button', sub_type: 'url', index: String(i), parameters: [{ type: 'text', text: b.text }] });
      });
      return { ...base, type: 'template', template: { name: spec.name, language: { code: spec.language || 'en' }, ...(components.length ? { components } : {}) } };
    }
    default:
      throw new Error(`Unknown message type ${spec.type}`);
  }
}

/** Human-readable preview used in the inbox and message log. */
export function previewOf(spec) {
  switch (spec.type) {
    case 'text': return spec.text;
    case 'buttons': return `${spec.text}\n[${spec.buttons.map((b) => b.title).join(' | ')}]`;
    case 'list': return `${spec.text}\n[${spec.button || 'Choose'}: ${spec.sections.flatMap((s) => s.rows.map((r) => r.title)).join(', ')}]`;
    case 'location': return `📍 ${spec.name || 'Location'} ${spec.address ? '— ' + spec.address : ''} (${Number(spec.lat).toFixed(5)}, ${Number(spec.lng).toFixed(5)})`;
    case 'location_request': return `${spec.text}\n[📍 Send location]`;
    case 'cta_url': return `${spec.text}\n[${spec.display} → ${spec.url}]`;
    case 'image': return `🖼 ${spec.caption || 'Image'}`;
    case 'template': return `Template ${spec.name}: ${(spec.params || []).join(' | ')}`;
    default: return '';
  }
}

/** Fill a template body ({{1}}, {{2}}…) for previews and the simulator. */
export function renderTemplateBody(body, params) {
  return String(body || '').replace(/\{\{(\d+)\}\}/g, (_, n) => String((params || [])[Number(n) - 1] ?? ''));
}
