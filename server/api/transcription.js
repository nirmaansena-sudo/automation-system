import { all, one } from '../db/index.js';
import { notFound } from '../lib/http.js';
import { transcriptionStatus, transcribeMedia, reviewTranscript } from '../lib/transcription.js';
export function registerTranscription(r) {
  const auth = { auth: 'dashboard', roles: ['owner', 'manager'] };
  r.get('/api/voice/status', auth, () => transcriptionStatus());
  r.get('/api/voice/contact/:id', auth, (ctx) => {
    const id = Number(ctx.params.id);
    if (!one('SELECT id FROM contacts WHERE id=?', id)) throw notFound();
    return { ...transcriptionStatus(), transcripts: all("SELECT t.media_id,t.status,t.language,t.text,t.error,t.reviewed_at FROM media_transcripts t JOIN media a ON a.id=t.media_id WHERE a.status='stored' AND EXISTS(SELECT 1 FROM messages m WHERE m.media_id=t.media_id AND m.contact_id=?)", id) };
  });
  r.post('/api/voice/:id/transcribe', auth, (ctx) => transcribeMedia(Number(ctx.params.id), ctx.body?.language || 'auto', ctx.user));
  r.patch('/api/voice/:id/review', auth, (ctx) => reviewTranscript(Number(ctx.params.id), ctx.body?.text, ctx.user));
}
