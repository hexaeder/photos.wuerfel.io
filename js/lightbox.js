import { $, el, toast, confirmSheet, shortDate } from './ui.js';
import { colorFor, nameOf } from './identity.js';
import { frameNo, downloadName } from './photos.js';
import { canShareFiles, shareFiles, downloadUrl, isTouch } from './share.js';

// Paging is a native scroll-snap carousel rather than a touchend handler.
//
// The hand-rolled version had no movement — the image just cut to the next one
// — and it fought the page for the gesture, so a swipe scrolled vertically
// first. Handing the job to the browser buys finger-tracking, momentum,
// rubber-banding at the ends and correct gesture arbitration for free, and
// `touch-action: pan-x` on the track settles the axis question outright.
//
// Slides are created for every photo but only carry an `src` within ±2 of the
// current one; anything past ±4 is unloaded again, because a few dozen
// full-size decodes is how you crash mobile Safari.
//
// A slide never shows the original. It shows the ~512px thumbnail the grid
// already has in cache — instantly, no request — and then swaps in the ~2048px
// mid copy once that has decoded. Originals are several MB each and 48 MB
// apiece decoded, so paging through them was both slow and the thing NEAR/FAR
// were fighting. They are still what the Save button hands you; browsing just
// stopped paying for them.

const NEAR = 2;
const FAR = 4;

/** Resolves once the browser holds a decoded frame, so the swap can't flash. */
const preload = (url) => new Promise((resolve, reject) => {
  const probe = new Image();
  probe.onload = () => resolve(url);
  probe.onerror = () => reject(new Error(`could not load ${url}`));
  probe.src = url;
});

export function createLightbox({ backend, album, seen, onDeleted, onChanged, ctx }) {
  const box = $('lightbox');
  const track = $('lbTrack');

  let list = [];
  let idx = 0;
  let ready = null;      // File (share) or URL string (download), for the
  let token = 0;         // current slide; token guards a slow fetch landing
                         // after the user has swiped on.

  const CAN_SHARE = canShareFiles();
  const cur = () => list[idx];

  // ── slides ─────────────────────────────────────────────────────────────

  function buildTrack() {
    track.replaceChildren(...list.map(() =>
      el('div', { class: 'lbslide' }, el('img', { alt: '', decoding: 'async' }))));
  }

  const imgAt = (i) => track.children[i]?.firstElementChild;

  /**
   * Fill slide `i`, cheapest tier first.
   *
   * `mid/` is absent whenever the original was already under the cap, or when
   * the uploader's browser couldn't decode the file — so falling through to
   * the original is an ordinary path, not an error path. Same for the
   * thumbnail, which is why its own load failure just clears the src rather
   * than leaving a broken-image glyph on screen.
   */
  async function hydrate(i) {
    const img = imgAt(i);
    const rec = list[i];
    if (!img || !rec || img.dataset.k === rec.base) return;
    img.dataset.k = rec.base;
    const stale = () => img.dataset.k !== rec.base;   // swiped on mid-flight

    // loadWindow fires these off without awaiting, so nothing here may reject.
    try {
      img.onerror = () => img.removeAttribute('src');
      img.src = await backend.urlFor(rec.thumbKey);
    } catch { /* signing failed; the tiers below still get their turn */ }

    for (const key of [rec.midKey, rec.key]) {
      try {
        const url = await preload(await backend.urlFor(key));
        if (stale()) return;
        img.onerror = null;
        img.src = url;
        return;
      } catch {
        if (stale()) return;
      }
    }
    // Nothing above the thumbnail could be had — offline, most likely. Drop
    // the marker so the next pass through loadWindow tries again.
    delete img.dataset.k;
  }

  function loadWindow() {
    for (let i = 0; i < list.length; i++) {
      const d = Math.abs(i - idx);
      const img = imgAt(i);
      if (!img) continue;
      if (d <= NEAR) hydrate(i);
      else if (d > FAR && img.src) { img.removeAttribute('src'); delete img.dataset.k; }
    }
  }

  // ── the current photo ──────────────────────────────────────────────────

  async function onIndex() {
    const rec = cur();
    if (!rec) return close();

    const mine = ++token;
    const users = ctx.users;
    const colour = colorFor(rec.uid);

    $('lbSwatch').style.setProperty('--person', colour);
    $('lbWho').textContent = nameOf(users, rec.uid);
    $('lbFrame').textContent = frameNo(rec.num);
    $('lbFrame').style.setProperty('--person', colour);
    // When it was taken is what a person means by "when is this photo from";
    // the upload time is only a stand-in for photos whose EXIF didn't say.
    $('lbDate').textContent = shortDate(rec.captured ?? rec.ts);

    $('lbPrev').hidden = idx === 0;
    $('lbNext').hidden = idx === list.length - 1;
    $('lbDelete').hidden = album.readonly;
    $('lbUnmark').hidden = !seen.isSaved(rec);

    loadWindow();

    ready = null;
    const btn = $('lbSave');
    btn.classList.remove('primary');

    if (!CAN_SHARE) {
      // Presigning is pure crypto — no bytes move until the tap — and the
      // click that starts a download has to be synchronous inside that tap or
      // browsers block it. So the URL is prepared up front; it costs nothing.
      btn.disabled = true;
      btn.textContent = 'Download';
      try {
        ready = await backend.downloadUrlFor(rec.key, downloadName(rec, album.n));
        if (token !== mine) return;                  // swiped on; discard
        btn.disabled = false;
      } catch {
        if (token === mine) btn.textContent = 'Unavailable';
      }
      return;
    }

    // Web Share is the opposite: it needs the actual bytes in hand *before*
    // the tap that shares them, because iOS drops the gesture across an await.
    // That used to be done eagerly here, which meant swiping through fifty
    // photos downloaded fifty originals for Save buttons nobody pressed. Now
    // the first tap fetches and the second shares — see fetchForShare().
    // Nothing above the mid copy (§7.6) moves until someone asks for it.
    btn.disabled = false;
    btn.textContent = 'Save';
  }

  /** Tap 1 of a share: pull the original down and re-arm the button. */
  async function fetchForShare(rec) {
    const btn = $('lbSave');
    const mine = token;
    btn.disabled = true;
    btn.textContent = 'Fetching…';
    let blob;
    try {
      blob = await backend.get(rec.key);
    } catch {
      if (token === mine) btn.textContent = 'Unavailable';
      return;
    }
    if (token !== mine) return;                      // swiped on; onIndex reset it
    ready = new File([blob], downloadName(rec, album.n),
                     { type: blob.type || 'image/jpeg' });
    btn.disabled = false;
    btn.textContent = 'Save to Photos';
    btn.classList.add('primary');   // it changed meaning; make that impossible to miss
  }

  function markSaved(rec) {
    seen.markSaved([rec]);
    onChanged?.();
    $('lbUnmark').hidden = false;
  }

  // ── paging ─────────────────────────────────────────────────────────────

  function goTo(i, smooth = true) {
    const next = Math.max(0, Math.min(list.length - 1, i));
    track.scrollTo({ left: next * track.clientWidth, behavior: smooth ? 'smooth' : 'auto' });
    if (next !== idx) { idx = next; onIndex(); }
  }

  let settle;
  track.addEventListener('scroll', () => {
    clearTimeout(settle);
    settle = setTimeout(() => {
      const i = Math.round(track.scrollLeft / track.clientWidth);
      if (i !== idx && i >= 0 && i < list.length) { idx = i; onIndex(); }
    }, 80);
  }, { passive: true });

  addEventListener('resize', () => {
    if (!box.hidden) track.scrollLeft = idx * track.clientWidth;
  });

  // ── open / close ───────────────────────────────────────────────────────

  function open(recs, rec) {
    list = recs;
    idx = Math.max(0, recs.findIndex((r) => r.base === rec.base));
    box.hidden = false;
    document.body.style.overflow = 'hidden';
    buildTrack();
    // The track needs a layout pass before scrollLeft means anything.
    requestAnimationFrame(() => {
      track.scrollLeft = idx * track.clientWidth;
      onIndex();
    });
  }

  function close() {
    box.hidden = true;
    document.body.style.overflow = '';
    track.replaceChildren();
    ready = null;
    token++;
  }

  $('lbClose').onclick = close;
  $('lbPrev').onclick = () => goTo(idx - 1);
  $('lbNext').onclick = () => goTo(idx + 1);

  document.addEventListener('keydown', (e) => {
    if (box.hidden) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') goTo(idx - 1);
    else if (e.key === 'ArrowRight') goTo(idx + 1);
  });

  // ── actions ────────────────────────────────────────────────────────────

  $('lbSave').onclick = async () => {
    const rec = cur();

    if (!CAN_SHARE) {
      if (!ready) return;
      downloadUrl(ready);                           // synchronous: inside the tap
      markSaved(rec);
      toast(isTouch() ? 'Saved to Downloads' : 'Downloaded');
      return;
    }

    if (!ready) return fetchForShare(rec);          // tap 1

    try {
      await shareFiles([ready]);                    // nothing awaited before this
      markSaved(rec);
      toast('Marked as saved — pick “Save Image” in the sheet');
    } catch (e) {
      if (e.name === 'AbortError') return;          // sheet dismissed
      toast(`Could not save: ${e.message}`, 'bad');
    }
  };

  $('lbUnmark').onclick = () => {
    const rec = cur();
    seen.markUnsaved([rec]);
    onChanged?.();
    $('lbUnmark').hidden = true;
    toast('Marked as not saved');
  };

  $('lbDelete').onclick = async () => {
    const rec = cur();
    const mine = rec.uid === ctx.me?.uid;
    const who = nameOf(ctx.users, rec.uid);

    const go = await confirmSheet({
      title: `Delete frame ${frameNo(rec.num)}?`,
      body: mine
        ? 'This removes it from the album for everyone, permanently — there are no older versions to fall back on.'
        : `This is ${who}’s photo. Deleting it removes it for everyone, permanently, and ${who} is not told.`,
      confirm: mine ? 'Delete' : `Delete ${who}’s photo`,
      danger: true,
    });
    if (!go) return;

    try {
      await backend.remove(rec.key);
      await backend.remove(rec.thumbKey);
      await backend.remove(rec.midKey);
    } catch (e) {
      toast(e.status === 403
        ? 'This link can no longer change the album.'
        : `Could not delete: ${e.message}`, 'bad');
      return;
    }

    const at = idx;
    list = list.filter((r) => r.base !== rec.base);
    onDeleted?.(rec);
    toast('Deleted');

    if (!list.length) return close();
    idx = Math.min(at, list.length - 1);
    buildTrack();
    requestAnimationFrame(() => {
      track.scrollLeft = idx * track.clientWidth;
      onIndex();
    });
  };

  return { open, close };
}
