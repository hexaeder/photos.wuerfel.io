import { downloadName } from './photos.js';

// Getting photos off the page and into the phone's library.
//
// On Android and iOS that means navigator.share({files}) — the system sheet
// has a real "Save to Photos" target. Verified on both in Phase 0, including
// multi-file batches. Everywhere else we fall back to plain downloads.
//
// Branch on canSaveToGallery(), never on the user agent.

// How much one share() call is asked to carry.
//
// iOS needs a user gesture per share(), so every batch costs a tap — which
// means batching small is a *worse* experience, not a safer one. The real limit
// isn't a file count at all, it's how many originals can sit in memory at once
// while the sheet enumerates them, so the budget is in bytes. Records carry
// their `size` from the bucket listing, so this is known before anything is
// fetched.
//
// 400 MB is a deliberate guess and the number to tune first if bulk save
// misbehaves: Phase 0 only ever verified a 3-file share on hardware. The count
// cap is a backstop against a share sheet being handed a thousand tiny files.
export const BATCH_BYTES = 400 * 1024 * 1024;
export const BATCH_COUNT = 200;

/**
 * Split records into share batches, largest batches the budget allows.
 *
 * A single file over the budget still gets a batch of its own rather than being
 * dropped — better to try and fail visibly than to silently skip a photo.
 */
export function shareBatches(recs, maxBytes = BATCH_BYTES, maxCount = BATCH_COUNT) {
  const out = [];
  let cur = [];
  let bytes = 0;
  for (const rec of recs) {
    if (cur.length && (cur.length >= maxCount || bytes + (rec.size || 0) > maxBytes)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(rec);
    bytes += rec.size || 0;
  }
  if (cur.length) out.push(cur);
  return out;
}

let _can = null;

/**
 * A phone or tablet, as opposed to something with a keyboard.
 *
 * The *primary* pointer being coarse is the honest question, and it is not
 * user-agent sniffing — it asks about the input device, which is exactly what
 * both callers care about. `navigator.maxTouchPoints > 0` was the earlier test
 * and it's wrong here: a touch-screen Windows laptop answers yes to it while
 * behaving like a desktop in every way that matters below.
 */
export const isHandheld = () => matchMedia('(pointer: coarse)').matches;

/** Can this browser hand files to the OS at all? Not exported: see below. */
function canShareFiles() {
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

/**
 * Can it put files into the OS *photo library* — which is the only reason we
 * prefer sharing over downloading?
 *
 * Desktop Chrome answers yes to `canShareFiles()` and is still the wrong place
 * to use it. It really does implement `share({ files })`, but the Windows sheet
 * it opens offers Mail and Teams rather than "save to this folder", so it's the
 * wrong affordance for a tool whose whole job is getting files onto disk — and
 * it rejects with `NotAllowedError` often enough to look broken, where a
 * download never does. Desktop belongs in the download class.
 *
 * `canShareFiles` deliberately isn't exported: on its own it's the wrong thing
 * to branch on, and an export would invite exactly that.
 */
export const canSaveToGallery = () => canShareFiles() && isHandheld();

/**
 * Why a share failed, in words that say what to do about it.
 *
 * Web Share rejects with `NotAllowedError` when it can't tie the call to a
 * fresh user gesture. The bytes are still in hand, so tapping again genuinely
 * works — which is worth saying, because "permission denied" reads like a
 * setting the user has to go and change.
 */
export const shareFailure = (e) => (e.name === 'NotAllowedError'
  ? 'The browser wouldn’t open the share sheet. Tap Save again.'
  : `Could not save: ${e.message}`);

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

// Phones without Web Share need one download per tap — `isHandheld()` above is
// the test. Desktop browsers happily fire a queue of downloads from a single
// gesture (Chrome asks once, then allows the rest), but Android WebView
// browsers — which is what DuckDuckGo, and anything else not built on Chrome,
// actually is — silently drop everything after the first. So on a handheld we
// step through instead of pretending the queue worked.

/** Trigger one download. Synchronous, so it can sit inside a tap handler. */
export function downloadUrl(url) {
  const a = Object.assign(document.createElement('a'), {
    href: url, rel: 'noopener',
  });
  document.body.append(a);
  a.click();
  a.remove();
}

/** Desktop: fire the whole queue. */
export async function downloadAll(urls) {
  for (const url of urls) {
    downloadUrl(url);
    await new Promise((r) => setTimeout(r, 350));
  }
}

/**
 * Why file-saving is unavailable, in words a person can act on.
 *
 * Naming browsers is worth the specificity: the ones that work are the
 * Chromium-based ones. Firefox for Android is the trap — it *has*
 * `navigator.share`, so it looks supported, but it cannot share files, so it
 * lands here too.
 */
export const noShareReason = () => isHandheld()
  ? 'This browser can’t hand photos to your gallery, so they go to Downloads — look for a “Download” album. Chrome, Brave, Edge and Samsung Internet save straight to Photos. Firefox can’t either.'
  : 'Downloading to this computer.';
