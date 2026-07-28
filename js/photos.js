// The filename IS the index.
//
//   photos/1753612800000-a3f9c1-8b21d4e0.jpg
//          └ uploaded ms ┘ └uid┘ └ content hash ┘
//
// One ListObjectsV2 therefore returns the complete album — no index file to
// drift out of sync, and no shared object for concurrent uploaders to clobber.
// The content hash also gives dedup for free: re-uploading the same photo
// produces the same key, so it overwrites instead of duplicating.

const NAME = /^(\d{10,16})-([0-9a-f]{4,16})-([0-9a-f]{6,32})\.([a-z0-9]{1,5})$/i;

// Three sizes per photo, all sharing one base name:
//
//   photos/  the original bytes, untouched — the thing people came to download
//   mid/     ~2048px JPEG, what the lightbox shows
//   thumbs/  ~512px JPEG, what the grid shows
//
// Derivatives are always JPEG, whatever the original was.
export const thumbKeyFor = (base) => `thumbs/${base}.jpg`;
export const midKeyFor = (base) => `mid/${base}.jpg`;
export const photoKeyFor = (base, ext) => `photos/${base}.${ext}`;
export const baseFor = (ts, uid, hash) => `${ts}-${uid}-${hash}`;

/**
 * Album listing → records, newest first.
 *
 * Frame numbers are assigned from the full oldest-first list so that a photo
 * keeps its number when you filter by person — the number means "when it
 * arrived", which is information, not decoration.
 */
export function parsePhotos(entries) {
  const recs = [];
  for (const e of entries) {
    const m = NAME.exec(e.name);
    if (!m) continue;   // the prefix can hold anything; ignore what isn't ours
    const [, ts, uid, hash, ext] = m;
    const base = `${ts}-${uid}-${hash}`;
    recs.push({
      base,
      key: photoKeyFor(base, ext),
      thumbKey: thumbKeyFor(base),
      // May not exist: originals already under the cap don't get one, and
      // neither do files the uploader's browser couldn't decode. The lightbox
      // treats a miss as a normal fallback, not an error.
      midKey: midKeyFor(base),
      ts: +ts,
      uid,
      hash,
      ext: ext.toLowerCase(),
      size: e.size,
    });
  }

  recs.sort((a, b) => a.ts - b.ts || a.hash.localeCompare(b.hash));
  recs.forEach((r, i) => { r.num = i + 1; });
  recs.reverse();
  return recs;
}

export const hashesOf = (recs) => new Set(recs.map((r) => r.hash));

/** uid → count, for the filter chips. */
export function countByUid(recs) {
  const counts = new Map();
  for (const r of recs) counts.set(r.uid, (counts.get(r.uid) ?? 0) + 1);
  return counts;
}

/** Insert a new record and renumber. Cheap enough to just redo it. */
export function addPhoto(recs, rec) {
  recs.unshift(rec);
  const oldestFirst = [...recs].reverse();
  oldestFirst.forEach((r, i) => { r.num = i + 1; });
  return recs;
}

export const frameNo = (n) => String(n).padStart(3, '0');

/** Filename for a download. Frame number first, so a batch sorts sensibly. */
export const downloadName = (rec, albumName) =>
  `${(albumName || 'photo').replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase()}` +
  `-${frameNo(rec.num)}.${rec.ext}`;
