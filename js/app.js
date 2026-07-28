import { $, el, show, toast, taskSheet, confirmSheet, plural } from './ui.js';
import { albumFromLocation, albumFromText, fragmentFromText } from './album.js';
import { s3Backend } from './backend-s3.js';
import { parsePhotos, hashesOf, frameNo, downloadName } from './photos.js';
import {
  loadMe, saveMe, newUid, randomName, colorFor, setPalette,
  loadUsers, writeUser, nameOf,
} from './identity.js';
import { createSeen } from './seen.js';
import { createGallery } from './gallery.js';
import { createLightbox } from './lightbox.js';
import { createUploader } from './upload.js';
import {
  canShareFiles, fetchFiles, chunk, shareFiles, BATCH,
  isTouch, downloadUrl, downloadAll, noShareReason,
} from './share.js';

/** Shared state. The lightbox reads me/users through this, so a rename or an
    identity switch reaches it without rewiring anything. */
const ctx = { me: null, users: new Map() };

let album = null;
let backend = null;
let recs = [];
let existing = new Set();
let seen = null;
let gallery = null;
let lightbox = null;
let uploader = null;

// ── error messages that say what to do ───────────────────────────────────

function explain(e) {
  if (e.code === 'RequestTimeTooSkewed') {
    return "The storage rejected this request because the clock on this device is wrong. Fix the date and time, then reload.";
  }
  if (e.code === 'SignatureDoesNotMatch') {
    return "The link's key was rejected. Either the link got mangled in transit, or this device's clock is badly wrong.";
  }
  if (e.status === 403) {
    return 'This link no longer works — it has been revoked or has expired. Ask whoever shared it for a new one.';
  }
  if (e.status === 404) return 'That album is gone.';
  if (e instanceof TypeError) {
    return 'Could not reach the storage. Check your connection and try again.';
  }
  return e.message;
}

function showLink(message) {
  if (message) {
    $('linkErr').textContent = message;
    $('linkErr').hidden = false;
  }
  show('link');
}

// ── the overflow guard the spike needed ──────────────────────────────────
// The spike scrolled sideways on an iPhone mini and nobody noticed until it
// was on a phone. This warns in the console the moment it happens again.

function checkOverflow() {
  const d = document.documentElement;
  if (d.scrollWidth > d.clientWidth + 1) {
    console.warn('[photoshare] horizontal overflow — page is %dpx wide in a %dpx viewport',
                 d.scrollWidth, d.clientWidth);
  }
}

// ── identity ─────────────────────────────────────────────────────────────

/**
 * Everyone the album knows about — including uids that only appear in
 * filenames, so someone whose users/ entry is missing still gets a colour.
 *
 * Ordered by first upload, because setPalette treats the order as join order:
 * appending a newcomer then leaves everyone else's colour alone.
 */
function repalette() {
  const firstSeen = new Map();
  for (let i = recs.length - 1; i >= 0; i--) {       // recs is newest-first
    if (!firstSeen.has(recs[i].uid)) firstSeen.set(recs[i].uid, recs[i].ts);
  }
  const all = new Set([...firstSeen.keys(), ...ctx.users.keys(), ctx.me?.uid].filter(Boolean));
  setPalette([...all].sort((a, b) =>
    (firstSeen.get(a) ?? Infinity) - (firstSeen.get(b) ?? Infinity) || a.localeCompare(b)));
}

function openIdentity({ returning = false } = {}) {
  const candidate = ctx.me ?? { uid: newUid(), name: randomName() };
  const firstTime = !ctx.me;

  $('identAlbum').textContent = album.n;
  // A newcomer starts with an empty field rather than a prefilled random name:
  // a name someone typed is worth far more to the group than one we invented,
  // and a prefilled field reads as already answered. The random name survives
  // as the fallback below, unseen unless it's actually needed.
  $('nameInput').value = firstTime ? '' : candidate.name;
  $('identSwatch').style.setProperty('--person', colorFor(candidate.uid));
  $('identCancel').hidden = !returning;

  // The nudge is the button itself: nothing is blocked, but leaving the field
  // empty visibly costs you the primary action and says what you're skipping.
  const syncGo = () => {
    const typed = $('nameInput').value.trim();
    const go = $('identGo');
    go.textContent = returning ? 'Save' : typed ? 'Start' : 'Start without a name';
    // Plain (bordered) rather than `ghost` when empty — still an obvious
    // button, just no longer the highlighted one.
    go.classList.toggle('primary', Boolean(typed) || returning);
  };
  $('nameInput').oninput = syncGo;
  syncGo();

  const others = [...ctx.users.values()].filter((u) => u.uid !== candidate.uid);
  $('identKnown').hidden = others.length === 0;
  $('identList').replaceChildren(...others
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((u) => {
      const b = el('button', {
        class: 'knownbtn',
        type: 'button',
        onclick: () => start({ uid: u.uid, name: u.name }),
      }, el('span', { class: 'swatch' }), el('span', { text: u.name }));
      b.style.setProperty('--person', colorFor(u.uid));
      return b;
    }));

  $('identGo').onclick = () => {
    const name = $('nameInput').value.trim() || candidate.name;
    start({ uid: candidate.uid, name });
  };
  $('nameInput').onkeydown = (e) => { if (e.key === 'Enter') $('identGo').click(); };
  $('identCancel').onclick = () => show('gallery');

  show('identity');
}

async function start(me) {
  const renamed = ctx.users.get(me.uid)?.name !== me.name;
  const switched = ctx.me && ctx.me.uid !== me.uid;

  ctx.me = saveMe(me);
  ctx.users.set(me.uid, { uid: me.uid, name: me.name });
  repalette();

  if (renamed && !album.readonly) {
    // Names resolve at render time, so every existing photo relabels itself.
    writeUser(backend, me).catch(() => {
      toast('Saved on this device, but the album could not be updated.', 'bad');
    });
  }

  $('whoName').textContent = me.name;
  $('whoSwatch').style.setProperty('--person', colorFor(me.uid));

  // Seen state belongs to the person, so switching identity reloads it.
  if (!seen || switched) {
    seen = createSeen(backend, `${album.b}/${album.p}`, me.uid);
    await seen.load();
  }

  if (gallery && !switched) {
    // A rename changes labels, nothing else. Rebuilding the grid would drop
    // every loaded thumbnail and re-sign every URL for a typo fix.
    gallery.relabel(ctx.users);
    gallery.refresh();
  } else {
    buildGallery();
  }

  show('gallery');
  checkOverflow();

  // Advance lastSeenAt only once the gallery has actually been looked at — on
  // every page load and "new" would stop meaning anything.
  setTimeout(() => seen.touch(), 4000);
}

// ── gallery ──────────────────────────────────────────────────────────────

function buildGallery() {
  if (!gallery) {
    gallery = createGallery({
      backend,
      seen: { isNew: (r, me) => seen.isNew(r, me), isSaved: (r) => seen.isSaved(r) },
      onOpen: (rec) => lightbox.open(gallery.visible(), rec),
      onSelect: renderSelection,
    });

    lightbox = createLightbox({
      backend, album, ctx,
      seen: {
        markSaved: (r) => seen.markSaved(r),
        markUnsaved: (r) => seen.markUnsaved(r),
        isSaved: (r) => seen.isSaved(r),
      },
      onChanged: () => gallery.refresh(),
      onDeleted: forget,
    });

    uploader = createUploader({
      backend, album, ctx, existing,
      onUploaded: (rec) => {
        recs.unshift(rec);
        recs.slice().reverse().forEach((r, i) => { r.num = i + 1; });
        gallery.add(rec);
      },
    });

    $('addBtn').onclick = () => uploader.pick();
    $('saveAllBtn').onclick = () => saveAll(gallery.pending());
    $('whoBtn').onclick = () => openIdentity({ returning: true });
    $('upClose').onclick = () => taskSheet.close();

    $('selectBtn').onclick = () => {
      if (!gallery.isSelecting()) gallery.setSelecting(true);
      else gallery.selectAll(!gallery.allSelected());
    };
    $('selCancel').onclick = () => gallery.setSelecting(false);
    $('selSave').onclick = () => saveAll(gallery.selected());
    $('selUnmark').onclick = () => {
      const n = seen.markUnsaved(gallery.selected());
      gallery.setSelecting(false);
      gallery.refresh();
      toast(n ? `${plural(n, 'photo')} marked as not saved` : 'Nothing to unmark');
    };
    $('selDelete').onclick = deleteSelected;
  }

  $('galTitle').textContent = album.n;
  $('addBtn').hidden = album.readonly;
  gallery.render(recs, ctx.users, ctx.me);
}

// ── selection ────────────────────────────────────────────────────────────

/** Drop a deleted photo from every structure that remembers it. */
function forget(rec) {
  recs = recs.filter((r) => r.base !== rec.base);
  existing.delete(rec.hash);
  recs.slice().reverse().forEach((r, i) => { r.num = i + 1; });
  gallery.remove(rec.base);
}

function renderSelection(picked) {
  const on = gallery.isSelecting();
  $('headNormal').hidden = on;
  $('headSelect').hidden = !on;
  $('selActs').hidden = !on;
  $('addBtn').hidden = on || album.readonly;
  $('saveAllBtn').hidden = on || gallery.pending().length === 0;

  $('selectBtn').textContent = !on ? 'Select'
    : gallery.allSelected() ? 'Clear' : 'Select all';
  $('selectBtn').classList.toggle('on', on);

  if (!on) return;
  $('selCount').textContent = picked.length
    ? `${picked.length} selected`
    : 'Tap photos to select';
  for (const id of ['selSave', 'selUnmark', 'selDelete']) {
    $(id).disabled = picked.length === 0;
  }
  $('selSave').textContent = canShareFiles() ? `Save ${picked.length || ''}`.trim()
                                             : `Get ${picked.length || ''}`.trim();
  $('selDelete').hidden = album.readonly;
}

async function deleteSelected() {
  const picked = gallery.selected();
  if (!picked.length) return;

  const others = picked.filter((r) => r.uid !== ctx.me?.uid);
  const names = [...new Set(others.map((r) => nameOf(ctx.users, r.uid)))];

  const go = await confirmSheet({
    title: `Delete ${plural(picked.length, 'photo')}?`,
    body: others.length
      ? `${plural(others.length, 'of them belongs', 'of them belong')} to ${names.join(', ')}. `
        + 'Deleting removes them from the album for everyone, permanently, and nobody is told.'
      : 'This removes them from the album for everyone, permanently — there are no older versions to fall back on.',
    confirm: `Delete ${picked.length}`,
    danger: true,
  });
  if (!go) return;

  taskSheet.open({ title: 'Deleting', summary: `${plural(picked.length, 'photo')}…` });
  let gone = 0;
  let failed = 0;

  for (const rec of picked) {
    const set = taskSheet.row(`${frameNo(rec.num)} · ${nameOf(ctx.users, rec.uid)}`);
    try {
      await backend.remove(rec.key);
      await backend.remove(rec.thumbKey);
      await backend.remove(rec.midKey);
      forget(rec);
      set('done', 'Deleted');
      gone++;
    } catch (e) {
      set('fail', e.status === 403 ? 'Not allowed' : 'Failed');
      failed++;
    }
  }

  gallery.setSelecting(false);
  taskSheet.summary(failed
    ? `${gone} deleted, ${failed} could not be — the link may no longer be able to change the album.`
    : `${plural(gone, 'photo')} deleted.`)
    .action('Done', () => taskSheet.close());
}

// ── bulk save ────────────────────────────────────────────────────────────

async function saveAll(list) {
  if (!list.length) return;
  gallery.setSelecting(false);

  const label = (r) => `${frameNo(r.num)} · ${nameOf(ctx.users, r.uid)}`;

  if (!canShareFiles()) return downloadAll_(list, label);

  taskSheet.open({
    title: 'Saving to your photos',
    summary: `${plural(list.length, 'photo')} to save`,
  });

  const rows = new Map();
  for (const r of list) rows.set(r.base, taskSheet.row(label(r)));

  // iOS wants a user gesture per share() call, so batches get one tap each —
  // and each batch is fetched immediately before its own tap rather than the
  // whole selection up front. Fetching everything first held every original in
  // memory before you could save any of them, and made the first save wait on
  // the last download. This is also the shape a video would need.
  const batches = chunk(list, BATCH);
  let b = 0;

  const offer = async () => {
    const recs = batches[b];
    const from = b * BATCH + 1;
    const to = from + recs.length - 1;

    taskSheet.hideAction();
    taskSheet.summary(batches.length > 1
      ? `Fetching ${from}–${to} of ${list.length}…`
      : `Fetching ${plural(list.length, 'photo')}…`);

    let files;
    try {
      files = await fetchFiles(backend, recs, album.n, (done, _total, rec) => {
        rows.get(rec.base)?.('done', 'Ready');
      });
    } catch (e) {
      taskSheet.summary(explain(e)).action('Close', () => taskSheet.close());
      return;
    }

    taskSheet.summary(batches.length > 1
      ? `Ready. Your phone takes them ${BATCH} at a time — pick “Save Images” each time.`
      : 'Ready. Pick “Save Images” in the sheet that opens.');
    taskSheet.action(
      batches.length > 1 ? `Save ${from}–${to} of ${list.length}` : `Save ${plural(files.length, 'photo')}`,
      async () => {
        try {
          await shareFiles(files);        // nothing awaited first: gesture intact
        } catch (e) {
          if (e.name !== 'AbortError') toast(`Could not save: ${e.message}`, 'bad');
          return;
        }
        seen.markSaved(recs);
        gallery.refresh();
        b++;
        if (b < batches.length) offer();
        else {
          taskSheet.summary('Saved. Check your photo library.')
                   .action('Done', () => taskSheet.close());
        }
      });
  };
  offer();
}

/**
 * No Web Share: download instead.
 *
 * The bytes never touch JS here — each photo gets a presigned URL that carries
 * its own filename, so the browser downloads straight from Wasabi under a name
 * like `norway-2026-007.jpg`.
 *
 * Desktop can fire the whole queue from one gesture. A phone cannot: Android
 * WebView browsers drop everything after the first download, which is exactly
 * how this surfaced — eleven photos requested, one arrived, named after a blob
 * UUID. So on a touch device we step through, one tap per photo, and say why.
 */
async function downloadAll_(list, label) {
  taskSheet.open({
    title: 'Downloading',
    summary: `Preparing ${plural(list.length, 'photo')}…`,
  });

  const rows = list.map((r) => taskSheet.row(label(r)));

  let items;
  try {
    items = await Promise.all(list.map(async (rec) => ({
      rec,
      url: await backend.downloadUrlFor(rec.key, downloadName(rec, album.n)),
    })));
  } catch (e) {
    taskSheet.summary(explain(e)).action('Close', () => taskSheet.close());
    return;
  }

  const finish = () => {
    seen.markSaved(list);
    gallery.refresh();
    taskSheet.summary(`${plural(list.length, 'photo')} sent to Downloads.`)
             .action('Done', () => taskSheet.close());
  };

  if (!isTouch()) {
    taskSheet.summary(noShareReason());
    await downloadAll(items.map((i) => i.url));
    rows.forEach((set) => set('done', 'Saved'));
    finish();
    return;
  }

  let i = 0;
  const offerNext = () => {
    taskSheet.summary(noShareReason());
    taskSheet.action(`Download ${i + 1} of ${items.length}`, () => {
      downloadUrl(items[i].url);          // synchronous: stays inside the tap
      rows[i]('done', 'Saved');
      i++;
      if (i < items.length) offerNext();
      else finish();
    });
  };
  offerNext();
}

// ── boot ─────────────────────────────────────────────────────────────────

async function openAlbum(a) {
  album = a;
  show('boot');
  $('bootMsg').textContent = `Opening ${album.n}…`;

  if (!window.isSecureContext || !crypto.subtle) {
    return showLink('This page needs HTTPS to work. Open it over https:// (or http://localhost while developing).');
  }

  backend = s3Backend(album);

  let entries, meta;
  try {
    [entries, ctx.users, meta] = await Promise.all([
      backend.list('photos/'),
      loadUsers(backend).catch(() => new Map()),
      // A compact link carries no title, so the album's own record is where it
      // comes from. Never fatal: the slug is already a usable name, and an
      // album that predates album.json should still open.
      backend.getJSON('album.json').catch(() => null),
    ]);
  } catch (e) {
    return showLink(explain(e));
  }
  if (meta?.title) album.n = meta.title;

  recs = parsePhotos(entries);
  existing = hashesOf(recs);
  repalette();

  const me = loadMe();
  if (me) await start(me);
  else openIdentity();
}

$('linkGo').onclick = () => {
  $('linkErr').hidden = true;
  let a;
  try {
    a = albumFromText($('linkInput').value);
  } catch (e) {
    return showLink(e.message);
  }
  // Put the link in the address bar so a reload keeps working.
  history.replaceState(null, '', fragmentFromText($('linkInput').value));
  openAlbum(a);
};

// A static site with no service worker still gets cached hard by phones, and
// "am I actually running what I just pushed?" is otherwise unanswerable. Note
// this only tracks index.html's freshness — a stale cached module would not
// show up here.
$('verTag').textContent = document.body.dataset.version || '';

addEventListener('resize', checkOverflow);

// Seen-state writes are debounced by 1.5s, and closing a tab mid-debounce
// would drop them. Phones background a page far more often than they close it,
// so visibilitychange is the one that actually matters here.
addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') seen?.flush();
});
addEventListener('pagehide', () => seen?.flush());

try {
  const found = albumFromLocation();
  if (found) openAlbum(found);
  else showLink();
} catch (e) {
  showLink(e.message);
}
