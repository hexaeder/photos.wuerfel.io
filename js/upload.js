import { $, taskSheet, plural } from './ui.js';
import { baseFor, photoKeyFor, thumbKeyFor, midKeyFor } from './photos.js';

// <input type="file" accept="image/*" multiple> is genuinely the native
// picker: iOS opens the real Photos sheet, Android the system picker, and both
// hand back real File objects. No `capture` attribute — it forces the camera
// and removes the library.
//
// The original is uploaded byte-for-byte, always. The point of the app is that
// your friends get the real file instead of what a messenger app left of it,
// so there is no downscale option to get wrong — and because canvas
// re-encoding drops every EXIF tag, keeping the original bytes is also the
// only way capture date, camera and orientation survive the trip.
//
// The two derivatives exist purely so browsing doesn't cost what downloading
// costs.

const THUMB_MAX = 512;
const THUMB_Q = 0.7;
const MID_MAX = 2048;        // comfortably over a phone screen at 3x
const MID_Q = 0.82;
const PARALLEL_PUTS = 3;

const EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
  'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif',
  'image/gif': 'gif', 'image/avif': 'avif',
};

/** Extension from the MIME type, falling back to the filename. */
function extFor(file) {
  const known = EXT[(file.type || '').toLowerCase()];
  if (known) return known;
  const fromName = /\.([a-z0-9]{1,5})$/i.exec(file.name)?.[1]?.toLowerCase();
  return fromName || 'bin';
}

async function sha256Short(file) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].slice(0, 4)
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** OffscreenCanvas is missing on older Safari; fall back to a real canvas. */
async function encode(w, h, draw, quality) {
  if (typeof OffscreenCanvas !== 'undefined' && OffscreenCanvas.prototype.convertToBlob) {
    const cv = new OffscreenCanvas(w, h);
    draw(cv.getContext('2d'));
    return cv.convertToBlob({ type: 'image/jpeg', quality });
  }
  const cv = Object.assign(document.createElement('canvas'), { width: w, height: h });
  draw(cv.getContext('2d'));
  return new Promise((resolve) => cv.toBlob(resolve, 'image/jpeg', quality));
}

async function resize(bmp, max, quality) {
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  return encode(w, h, (g) => g.drawImage(bmp, 0, 0, w, h), quality);
}

/** At most `n` in flight. Phones on hotel wifi stall under twenty. */
function limiter(n) {
  let active = 0;
  const queue = [];
  const pump = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; pump(); });
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    pump();
  });
}

export function createUploader({ backend, ctx, existing, onUploaded }) {
  const picker = $('filePicker');

  picker.addEventListener('change', () => {
    const files = [...picker.files];
    picker.value = '';                 // so the same photo can be re-picked
    if (files.length) run(files);
  });

  async function run(files) {
    const limit = limiter(PARALLEL_PUTS);
    const failed = [];
    let added = 0;
    let skipped = 0;
    let forbidden = false;

    taskSheet.open({
      title: 'Adding photos',
      summary: `${plural(files.length, 'photo')} selected`,
    });

    const jobs = [];

    for (const file of files) {
      const setStatus = taskSheet.row(file.name);
      try {
        // Hashing and decoding stay sequential: twenty full-size decodes at
        // once is how you crash mobile Safari.
        const hash = await sha256Short(file);
        if (existing.has(hash)) {
          setStatus('dupe', 'Already here');
          skipped++;
          continue;
        }
        existing.add(hash);

        setStatus('work', 'Preparing');
        let thumb = null;
        let mid = null;
        try {
          // `from-image` explicitly: the spec's default moved to it, but older
          // Safari and Chrome shipped 'none', which would leave a rotated
          // photo's thumbnail sideways under an upright full-size view.
          const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
          thumb = await resize(bmp, THUMB_MAX, THUMB_Q);
          // No mid copy when the original is already small enough to be one —
          // re-encoding it would cost quality and save nothing.
          if (Math.max(bmp.width, bmp.height) > MID_MAX) {
            mid = await resize(bmp, MID_MAX, MID_Q);
          }
          bmp.close();
        } catch {
          // Undecodable (an exotic HEIC, say). Upload the original anyway —
          // losing the previews is better than losing the photo.
          thumb = null;
          mid = null;
        }

        const ts = Date.now();
        const base = baseFor(ts, ctx.me.uid, hash);
        const ext = extFor(file);
        const rec = {
          base, hash, ts, ext,
          uid: ctx.me.uid,
          key: photoKeyFor(base, ext),
          thumbKey: thumbKeyFor(base),
          midKey: midKeyFor(base),
          size: file.size,
          num: 0,
        };

        setStatus('work', 'Uploading');
        jobs.push(limit(async () => {
          try {
            // Derivatives first: the gallery is driven by photos/, so a
            // half-failed upload leaves an invisible orphan rather than a
            // tile with a hole in it.
            if (thumb) await backend.put(rec.thumbKey, thumb, 'image/jpeg');
            if (mid) await backend.put(rec.midKey, mid, 'image/jpeg');
            await backend.put(rec.key, file, file.type || undefined);
            setStatus('done', 'Added');
            added++;
            onUploaded(rec);
          } catch (e) {
            existing.delete(hash);
            failed.push(file);
            if (e.status === 403) forbidden = true;
            setStatus('fail', e.status === 403 ? 'Not allowed' : 'Failed');
          }
        }));
      } catch (e) {
        failed.push(file);
        setStatus('fail', e.message.slice(0, 40));
      }
    }

    await Promise.all(jobs);

    const bits = [];
    if (added) bits.push(`${plural(added, 'photo')} added`);
    if (skipped) bits.push(`${skipped} already here`);
    if (failed.length) bits.push(`${failed.length} failed`);
    taskSheet.summary(bits.join(' · ') || 'Nothing to do');

    if (forbidden) {
      // The upload window has a hard expiry in the IAM policy, so a link that
      // worked last month can stop working without anything else changing.
      taskSheet.summary('This link can no longer add photos — its upload window has closed. Ask whoever shared it for a fresh one.');
    }

    if (failed.length) {
      taskSheet.action(`Retry ${plural(failed.length, 'photo')}`, () => run(failed));
    } else {
      taskSheet.action('Done', () => taskSheet.close());
    }
  }

  return {
    pick: () => picker.click(),
    run,
  };
}
