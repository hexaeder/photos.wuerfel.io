import { downloadName } from './photos.js';

// Getting photos off the page and into the phone's library.
//
// On Android and iOS that means navigator.share({files}) — the system sheet
// has a real "Save to Photos" target. Verified on both in Phase 0, including
// multi-file batches. On desktop there's no such thing, so we fall back to
// plain downloads.
//
// Branch on canShare, never on the user agent.

export const BATCH = 10;

let _can = null;

/** Can this browser hand files to the OS? */
export function canShareFiles() {
  if (_can !== null) return _can;
  try {
    const probe = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'probe.jpg',
                           { type: 'image/jpeg' });
    _can = Boolean(navigator.share && navigator.canShare?.({ files: [probe] }));
  } catch {
    _can = false;
  }
  return _can;
}

export const chunk = (arr, n) =>
  Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

/**
 * Download the originals as Files, in order, three at a time.
 *
 * Bounded concurrency matters here: a phone on hotel wifi stalls under twenty
 * parallel requests, and twenty decoded full-size photos is also how you crash
 * mobile Safari.
 */
export async function fetchFiles(backend, recs, albumName, onProgress) {
  const files = new Array(recs.length);
  let next = 0;
  let done = 0;

  const worker = async () => {
    while (next < recs.length) {
      const i = next++;
      const rec = recs[i];
      const blob = await backend.get(rec.key);
      files[i] = new File([blob], downloadName(rec, albumName),
                          { type: blob.type || 'image/jpeg' });
      onProgress?.(++done, recs.length, rec);
    }
  };

  await Promise.all(Array.from({ length: Math.min(3, recs.length) }, worker));
  return files;
}

/**
 * Must be called straight from a tap. Awaiting anything first loses the user
 * gesture and iOS throws NotAllowedError — which is why every caller fetches
 * the bytes on an earlier tap and keeps them ready.
 */
export const shareFiles = (files) => navigator.share({ files });

/** Desktop: sequential downloads. Chrome asks once, then allows the rest. */
export async function downloadFiles(files) {
  for (const f of files) {
    const url = URL.createObjectURL(f);
    const a = Object.assign(document.createElement('a'), { href: url, download: f.name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** One file, one tap — used by the lightbox where the blob is already in hand. */
export async function saveOne(file) {
  if (canShareFiles()) {
    await shareFiles([file]);
    return 'shared';
  }
  await downloadFiles([file]);
  return 'downloaded';
}
