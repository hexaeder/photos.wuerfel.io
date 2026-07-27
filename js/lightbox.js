import { $, toast, confirmSheet, shortDate } from './ui.js';
import { colorFor, nameOf } from './identity.js';
import { frameNo, downloadName } from './photos.js';
import { canShareFiles, shareFiles, downloadUrl, isTouch } from './share.js';

export function createLightbox({ backend, album, seen, onDeleted, onSaved, ctx }) {
  const box = $('lightbox');
  let list = [];
  let i = 0;
  let ready = null;      // File for the photo on screen, once fetched
  let token = 0;         // guards against a slow fetch landing after a swipe

  const cur = () => list[i];

  // The button says what will actually happen, which is not the same thing on
  // every browser.
  const CAN_SHARE = canShareFiles();
  const SAVE_LABEL = CAN_SHARE ? 'Save' : 'Download';

  async function paint() {
    const rec = cur();
    if (!rec) return close();

    const mine = ++token;
    const me = ctx.me;
    const users = ctx.users;

    $('lbImg').alt = `Frame ${frameNo(rec.num)} by ${nameOf(users, rec.uid)}`;
    $('lbSwatch').style.setProperty('--person', colorFor(rec.uid));
    $('lbWho').textContent = nameOf(users, rec.uid);
    $('lbFrame').textContent = frameNo(rec.num);
    $('lbFrame').style.setProperty('--person', colorFor(rec.uid));
    $('lbDate').textContent = shortDate(rec.ts);

    $('lbPrev').hidden = i === 0;
    $('lbNext').hidden = i === list.length - 1;
    $('lbDelete').hidden = !(rec.uid === me?.uid && !album.readonly);

    // Fetch the original in the background so that when Save is tapped there
    // is nothing left to await. iOS drops the user gesture across an await,
    // so this is what keeps the share sheet reachable in one tap.
    ready = null;
    const btn = $('lbSave');
    btn.disabled = true;
    btn.textContent = SAVE_LABEL;

    // With Web Share, fetch the original in the background so that when Save
    // is tapped there is nothing left to await — iOS drops the user gesture
    // across an await, and that is what keeps the share sheet reachable in one
    // tap. Without Web Share we never need the bytes in JS at all: a presigned
    // download URL does the job and the button works immediately.
    const [url, blob] = await Promise.allSettled([
      backend.urlFor(rec.key),
      CAN_SHARE ? backend.get(rec.key)
                : backend.downloadUrlFor(rec.key, downloadName(rec, album.n)),
    ]);
    if (token !== mine) return;                   // swiped away; discard both

    if (url.status === 'fulfilled') $('lbImg').src = url.value;
    if (blob.status !== 'fulfilled') {
      btn.textContent = 'Unavailable';
      return;
    }
    ready = CAN_SHARE
      ? new File([blob.value], downloadName(rec, album.n),
                 { type: blob.value.type || 'image/jpeg' })
      : blob.value;                               // a URL string
    btn.disabled = false;
  }

  function open(recs, rec) {
    list = recs;
    i = Math.max(0, recs.findIndex((r) => r.base === rec.base));
    box.hidden = false;
    document.body.style.overflow = 'hidden';
    paint();
  }

  function close() {
    box.hidden = true;
    document.body.style.overflow = '';
    $('lbImg').removeAttribute('src');
    ready = null;
    token++;
  }

  const step = (d) => {
    const next = i + d;
    if (next < 0 || next >= list.length) return;
    i = next;
    paint();
  };

  $('lbClose').onclick = close;
  $('lbPrev').onclick = () => step(-1);
  $('lbNext').onclick = () => step(1);

  box.addEventListener('click', (e) => { if (e.target === box) close(); });

  document.addEventListener('keydown', (e) => {
    if (box.hidden) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
  });

  let touch = null;
  box.addEventListener('touchstart', (e) => {
    touch = { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
  }, { passive: true });
  box.addEventListener('touchend', (e) => {
    if (!touch) return;
    const dx = e.changedTouches[0].clientX - touch.x;
    const dy = e.changedTouches[0].clientY - touch.y;
    touch = null;
    if (Math.abs(dx) > 55 && Math.abs(dy) < 80) step(dx < 0 ? 1 : -1);
  }, { passive: true });

  $('lbSave').onclick = async () => {
    const rec = cur();
    if (!ready) return;

    if (!CAN_SHARE) {
      downloadUrl(ready);
      seen.markSaved([rec]);
      onSaved?.();
      toast(isTouch() ? 'Saved to Downloads' : 'Downloaded');
      return;
    }
    try {
      await shareFiles([ready]);                  // nothing awaited before this
      seen.markSaved([rec]);
      onSaved?.();
      toast('Marked as saved — pick “Save Image” in the sheet');
    } catch (e) {
      if (e.name === 'AbortError') return;        // the user dismissed the sheet
      toast(`Could not save: ${e.message}`, 'bad');
    }
  };

  $('lbDelete').onclick = async () => {
    const rec = cur();
    const go = await confirmSheet({
      title: `Delete frame ${frameNo(rec.num)}?`,
      body: 'This removes it from the album for everyone, permanently — there are no older versions to fall back on.',
      confirm: 'Delete',
      danger: true,
    });
    if (!go) return;

    try {
      await backend.remove(rec.key);
      await backend.remove(rec.thumbKey);
    } catch (e) {
      toast(e.status === 403
        ? 'This link can no longer change the album.'
        : `Could not delete: ${e.message}`, 'bad');
      return;
    }

    list = list.filter((r) => r.base !== rec.base);
    onDeleted?.(rec);
    if (!list.length) close();
    else { i = Math.min(i, list.length - 1); paint(); }
    toast('Deleted');
  };

  return { open, close };
}
