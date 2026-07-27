import { $, toast, confirmSheet, shortDate } from './ui.js';
import { colorFor, nameOf } from './identity.js';
import { frameNo, downloadName } from './photos.js';
import { canShareFiles, saveOne } from './share.js';

export function createLightbox({ backend, album, seen, onDeleted, onSaved, ctx }) {
  const box = $('lightbox');
  let list = [];
  let i = 0;
  let ready = null;      // File for the photo on screen, once fetched
  let token = 0;         // guards against a slow fetch landing after a swipe

  const cur = () => list[i];

  // Desktop has no share sheet, so the button says what actually happens.
  const SAVE_LABEL = canShareFiles() ? 'Save' : 'Download';

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

    const [url, blob] = await Promise.allSettled([
      backend.urlFor(rec.key),
      backend.get(rec.key),
    ]);
    if (token !== mine) return;                   // swiped away; discard both

    if (url.status === 'fulfilled') $('lbImg').src = url.value;
    if (blob.status === 'fulfilled') {
      ready = new File([blob.value], downloadName(rec, album.n),
                       { type: blob.value.type || 'image/jpeg' });
      btn.disabled = false;
    } else {
      btn.textContent = 'Unavailable';
    }
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
    const file = ready;
    if (!file) return;
    try {
      const how = await saveOne(file);            // no await before this one
      seen.markSaved([rec]);
      onSaved?.();
      toast(how === 'shared'
        ? 'Marked as saved — pick “Save Image” in the sheet'
        : 'Downloaded');
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
