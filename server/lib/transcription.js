// whisper.cpp /inference multipart contract:
// https://github.com/ggml-org/whisper.cpp/blob/master/examples/server/README.md
// The configured service is opt-in. No external endpoint is selected by default.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { one, run, tx } from '../db/index.js';
import { HttpError, bad, notFound } from './http.js';
import { nowIso } from './util.js';
import { audit } from '../core/base.js';
import { reserveCompute, finishCompute, effectiveLimit } from './costs.js';

const MAX_AUDIO = 8 * 1024 * 1024;
const extensions = { 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm' };
const inFlight = new Map();
export function transcriptionStatus() {
  return { enabled: !!config.transcription?.url, maxBytes: MAX_AUDIO,
    dailyLimit: effectiveLimit('transcription', config.transcription?.dailyLimit),
    timeoutMs: Math.min(30000, Math.max(1000, Number(config.transcription?.timeoutMs) || 30000)) };
}
export function getTranscript(mediaId) { return one('SELECT media_id,status,language,text,error,reviewed_by,reviewed_at,started_at,completed_at FROM media_transcripts WHERE media_id=?', mediaId) || null; }
function validateMedia(mediaId) {
  const media = one('SELECT * FROM media WHERE id=?', mediaId);
  if (!media || media.status !== 'stored' || !media.file_path) throw notFound('Audio file is unavailable');
  const mime = String(media.mime || '').split(';')[0].trim().toLowerCase();
  if (!extensions[mime]) throw bad('Only audio attachments can be transcribed');
  if (!one("SELECT id FROM messages WHERE media_id=? AND type='audio'", mediaId)) throw bad('Choose an audio message from the inbox');
  return { ...media, mime };
}
async function readAudio(media) {
  const root = await fs.realpath(config.mediaDir);
  let file;
  try { file = await fs.realpath(path.resolve(root, media.file_path)); } catch { throw notFound('Audio file is unavailable'); }
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw bad('Invalid audio path');
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_AUDIO) throw bad('Audio must be between 1 byte and 8 MB');
    const buffer = await handle.readFile();
    if (buffer.length > MAX_AUDIO) throw bad('Audio exceeds 8 MB');
    return buffer;
  } finally { await handle.close(); }
}
function inferenceUrl() {
  let url;
  try { url = new URL(config.transcription.url); } catch { throw bad('TRANSCRIPTION_URL is not a valid self-hosted endpoint'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw bad('Use a plain HTTP(S) inference URL without credentials or query parameters');
  if (url.pathname === '/') url.pathname = '/inference';
  if (!url.pathname.endsWith('/inference')) throw bad('TRANSCRIPTION_URL must end with /inference');
  return url;
}
async function runTranscription(mediaId, language, actor) {
  const media = validateMedia(mediaId);
  const cached = getTranscript(mediaId);
  if (cached?.status === 'complete') return { ...cached, cached: true };
  if (!config.transcription?.url) throw bad('Local transcription is disabled. Ask the owner to configure a self-hosted service.');
  if (!['auto', 'en', 'hi'].includes(language)) throw bad('Choose Auto/Hinglish, Hindi or English');
  const endpoint = inferenceUrl();
  if (cached?.status === 'processing' && Date.now() - Date.parse(cached.started_at) < 35000) throw new HttpError(409, 'This voice note is already being transcribed');
  const audio = await readAudio(media);
  const usageId = tx(() => {
    const id = reserveCompute('transcription', config.transcription.dailyLimit, { provider: 'self-hosted-whisper', mediaId });
    if (!id) throw new HttpError(429, 'Daily transcription limit reached. Listen to the audio or retry tomorrow.');
    const at = nowIso();
    run("INSERT INTO media_transcripts(media_id,status,language,requested_by,started_at,updated_at) VALUES (?,'processing',?,?,?,?) ON CONFLICT(media_id) DO UPDATE SET status='processing',language=excluded.language,requested_by=excluded.requested_by,started_at=excluded.started_at,updated_at=excluded.updated_at,error=NULL", mediaId, language, actor.id, at, at);
    audit(`user:${actor.id}`, 'voice.transcription_requested', 'media', mediaId, { language });
    return id;
  });
  const started = Date.now(); const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), transcriptionStatus().timeoutMs);
  try {
    const form = new FormData();
    form.set('file', new Blob([audio], { type: media.mime }), `voice.${extensions[media.mime]}`);
    form.set('response_format', 'json'); form.set('language', language);
    form.set('translate', 'false'); form.set('detect_language', 'false');
    form.set('temperature', '0');
    const headers = config.transcription.token ? { Authorization: `Bearer ${config.transcription.token}` } : {};
    const response = await fetch(endpoint, { method: 'POST', headers, body: form, signal: controller.signal, redirect: 'error' });
    if (!response.ok) throw new Error(`Transcription service returned HTTP ${response.status}. Check its audio format/model configuration.`);
    let bytes = 0; const chunks = [];
    for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 1024 * 1024) { controller.abort(); throw new Error('Transcription response exceeded the size limit'); } chunks.push(chunk); }
    let payload; try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Transcription service returned invalid JSON'); }
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    if (!text || text.length > 20000) throw new Error('No usable transcript returned (maximum 20000 characters)');
    tx(() => {
      // A privacy erase may have happened while the external worker was running.
      validateMedia(mediaId);
      run("UPDATE media_transcripts SET status='complete',text=?,original_text=?,error=NULL,completed_at=?,updated_at=? WHERE media_id=?", text, text, nowIso(), nowIso(), mediaId);
      finishCompute(usageId, 'ok', Date.now() - started);
      audit(`user:${actor.id}`, 'voice.transcription_completed', 'media', mediaId);
    });
    return { ...getTranscript(mediaId), cached: false };
  } catch (error) {
    const message = controller.signal.aborted ? 'Transcription timed out or exceeded its response limit. Listen to the audio or retry manually.' : String(error.message).slice(0, 300);
    tx(() => { run("UPDATE media_transcripts SET status='failed',error=?,updated_at=? WHERE media_id=?", message, nowIso(), mediaId); finishCompute(usageId, 'failed', Date.now() - started); });
    throw new HttpError(502, message);
  } finally { clearTimeout(timeout); }
}
export async function transcribeMedia(mediaId, language, actor) {
  if (inFlight.has(mediaId)) return inFlight.get(mediaId);
  if (inFlight.size >= 2) throw new HttpError(429, 'Two voice notes are already processing. Try again shortly.');
  const work = runTranscription(mediaId, language || 'auto', actor);
  inFlight.set(mediaId, work);
  try { return await work; } finally { inFlight.delete(mediaId); }
}
export function reviewTranscript(mediaId, text, actor) {
  validateMedia(mediaId);
  const cached = getTranscript(mediaId);
  if (cached?.status !== 'complete') throw bad('Transcribe the voice note before reviewing it');
  if (typeof text !== 'string' || !text.trim() || text.length > 20000) throw bad('Transcript must contain 1–20000 characters');
  return tx(() => {
    run('UPDATE media_transcripts SET text=?,reviewed_by=?,reviewed_at=?,updated_at=? WHERE media_id=?', text.trim(), actor.id, nowIso(), nowIso(), mediaId);
    audit(`user:${actor.id}`, 'voice.transcript_reviewed', 'media', mediaId);
    return getTranscript(mediaId);
  });
}
