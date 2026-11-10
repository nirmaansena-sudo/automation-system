import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UserQueue } from '../public/app/offline.js';
class MemoryStore {
  constructor() { this.records = new Map(); }
  async get(key) { return structuredClone(this.records.get(key)); }
  async set(key, value) { this.records.set(key, structuredClone(value)); }
  async remove(key) { this.records.delete(key); }
  async list(prefix) { return [...this.records].filter(([key]) => key.startsWith(prefix)).map(([, value]) => structuredClone(value)); }
}
test('offline work and cached forms remain isolated when employees switch accounts', async () => {
  const store = new MemoryStore(); const a = new UserQueue(store, 1); const b = new UserQueue(store, 2);
  await a.add({ type: 'attendance', client_event_id: 'same', photo: { data: 'private-photo' } });
  await a.cache('/api/app/me', { user: { id: 1 } });
  assert.equal((await b.items()).length, 0);
  assert.equal(await b.cached('/api/app/me'), undefined);
  await assert.rejects(() => b.add({ owner_user_id: 1, client_event_id: 'x' }), /different employee/);
  await b.add({ type: 'attendance', client_event_id: 'same' });
  await b.applyResults(await b.items(), [{ client_event_id: 'same', ok: true }]);
  assert.equal((await a.items())[0].photo.data, 'private-photo');
});
test('sync failures preserve photos, support retry, and only acknowledgements delete records', async () => {
  const q = new UserQueue(new MemoryStore(), 1);
  await q.add({ type: 'site_log', client_event_id: 'a', photos: [{ data: 'photo' }] });
  await q.add({ type: 'attendance', client_event_id: 'b' });
  const batch = await q.items();
  await q.applyResults(batch, [{ client_event_id: 'a', error: 'Assignment changed' }, { client_event_id: 'b', ok: true }]);
  assert.equal((await q.items()).length, 1);
  assert.equal((await q.items())[0].queue_status, 'needs_review');
  assert.equal((await q.items())[0].photos[0].data, 'photo');
  await q.retry('a');
  assert.equal((await q.items())[0].queue_status, 'pending');
  await q.applyResults(await q.items(), []);
  assert.equal((await q.items()).length, 1);
  await q.applyResults(await q.items(), [{ client_event_id: 'a', duplicate: true }]);
  assert.equal((await q.items()).length, 0);
});
test('storage-full failure is propagated so the UI cannot claim work was saved', async () => {
  const store = new MemoryStore(); store.set = async () => { throw new Error('QuotaExceededError'); };
  const q = new UserQueue(store, 1);
  await assert.rejects(() => q.add({ client_event_id: 'a' }), /QuotaExceededError/);
  assert.deepEqual(await q.items(), []);
});
