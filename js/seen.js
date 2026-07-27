// state/<uid>.json — what you've already seen and saved.
//
//   { uid, lastSeenAt, downloaded: [contentHash, …] }
//
// Written only by its owner, so two people uploading at once never touch the
// same key and no locking is needed. That one-writer-per-file rule is why
// there is no shared index.json anywhere in this design.

export function createSeen(backend, albumKey, uid) {
  const lsKey = `photoshare.seen.${albumKey}.${uid}`;

  let downloaded = new Set();
  let lastSeenAt = 0;
  /** Marks are computed against this, captured once at load, so badges don't
      disappear out from under you while you're looking at the gallery. */
  let snapshot = 0;
  let dirty = false;
  let flushTimer = null;
  let writesBlocked = false;

  const readLocal = () => {
    try {
      return JSON.parse(localStorage.getItem(lsKey) || 'null') || {};
    } catch {
      return {};
    }
  };

  const writeLocal = () => {
    try {
      localStorage.setItem(lsKey, JSON.stringify({
        lastSeenAt, downloaded: [...downloaded],
      }));
    } catch { /* full or private; the remote copy is the real one */ }
  };

  async function load() {
    const local = readLocal();
    const remote = await backend.getJSON(`state/${uid}.json`).catch(() => null);

    // Union rather than last-write-wins: using a phone and a laptop should
    // never lose state on either.
    downloaded = new Set([...(local.downloaded ?? []), ...(remote?.downloaded ?? [])]);
    lastSeenAt = Math.max(local.lastSeenAt ?? 0, Date.parse(remote?.lastSeenAt ?? 0) || 0);
    snapshot = lastSeenAt;
    writeLocal();
  }

  async function flush() {
    if (!dirty || writesBlocked) return;
    dirty = false;
    try {
      await backend.putJSON(`state/${uid}.json`, {
        uid,
        lastSeenAt: new Date(lastSeenAt || Date.now()).toISOString(),
        downloaded: [...downloaded],
      });
    } catch (e) {
      // A view-only link (or a lapsed upload window) can't write state. That's
      // not worth interrupting anyone over — the local mirror still works.
      if (e.status === 403) writesBlocked = true;
      else dirty = true;
    }
  }

  function schedule() {
    dirty = true;
    writeLocal();
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 1500);
  }

  return {
    load,
    flush,
    isNew: (rec, me) => rec.ts > snapshot && rec.uid !== me,
    isSaved: (rec) => downloaded.has(rec.hash),

    markSaved(recs) {
      let added = 0;
      for (const r of recs) if (!downloaded.has(r.hash)) { downloaded.add(r.hash); added++; }
      if (added) schedule();
      return added;
    },

    /** Advance lastSeenAt — call once the gallery has actually been looked at,
        not on every page load, or "new" stops meaning anything. */
    touch() {
      lastSeenAt = Date.now();
      schedule();
    },

    get snapshot() { return snapshot; },
  };
}
