// User-scoped durable records. IndexedDB transactions report quota failures before
// the caller says an action was saved; photos are not constrained by localStorage.
export class IndexedStore {
  constructor(factory = globalThis.indexedDB) { this.factory = factory; }
  async db() {
    if (!this.opening) this.opening = new Promise((resolve, reject) => {
      if (!this.factory) return reject(new Error('Offline storage is unavailable. Connect before saving.'));
      const request = this.factory.open('ns-offline-v2', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('records', { keyPath: 'key' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.opening;
  }
  async action(mode, operation) {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('records', mode);
      const request = operation(transaction.objectStore('records'));
      transaction.oncomplete = () => resolve(request?.result);
      transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error('Offline storage failed. Connect before saving.'));
    });
  }
  async get(key) { return (await this.action('readonly', (s) => s.get(key)))?.value; }
  async set(key, value) { await this.action('readwrite', (s) => s.put({ key, value })); }
  async remove(key) { await this.action('readwrite', (s) => s.delete(key)); }
  async list(prefix) {
    const range = globalThis.IDBKeyRange.bound(prefix, prefix + '\uffff');
    return (await this.action('readonly', (s) => s.getAll(range))).map((r) => r.value);
  }
}

export class UserQueue {
  constructor(storage, userId) {
    if (!Number.isInteger(Number(userId)) || Number(userId) < 1) throw new Error('Log in before saving offline work');
    this.storage = storage; this.userId = Number(userId); this.prefix = `queue:${this.userId}:`;
  }
  key(id) { return this.prefix + id; }
  async items() { return (await this.storage.list(this.prefix)).sort((a, b) => a.saved_at.localeCompare(b.saved_at)); }
  async add(item) {
    if (item.owner_user_id !== undefined && Number(item.owner_user_id) !== this.userId) throw new Error('This saved item belongs to a different employee');
    if (!item.client_event_id) throw new Error('Saved work needs a unique event ID');
    const existing = await this.storage.get(this.key(item.client_event_id));
    const record = { ...item, owner_user_id: this.userId, saved_at: existing?.saved_at || new Date().toISOString(), queue_status: 'pending', queue_error: null };
    await this.storage.set(this.key(item.client_event_id), record);
    return record;
  }
  async applyResults(batch, results) {
    if (!Array.isArray(results)) throw new Error('Invalid sync response; saved work has been kept');
    const allowed = new Set(batch.map((x) => x.client_event_id));
    for (const result of results) {
      if (!allowed.has(result.client_event_id)) continue;
      const key = this.key(result.client_event_id);
      const current = await this.storage.get(key);
      if (!current) continue;
      if (result.error) await this.storage.set(key, { ...current, queue_status: 'needs_review', queue_error: String(result.error) });
      else if (result.ok || result.duplicate) await this.storage.remove(key);
    }
  }
  async retry(id) {
    const current = await this.storage.get(this.key(id));
    if (current) await this.storage.set(this.key(id), { ...current, queue_status: 'pending', queue_error: null });
  }
  async discard(id) { await this.storage.remove(this.key(id)); }
  async cache(path, value) { await this.storage.set(`cache:${this.userId}:${path}`, { at: new Date().toISOString(), value }); }
  async cached(path) { return this.storage.get(`cache:${this.userId}:${path}`); }
}
