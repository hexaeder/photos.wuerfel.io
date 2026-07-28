import { $, el, plural } from './ui.js';
import { colorFor, nameOf, shortName } from './identity.js';
import { frameNo, byMode } from './photos.js';

// Tiles are built once and filtering toggles `hidden`. No re-render, no
// virtual DOM, and it stays smooth at a thousand photos.
//
// Re-sorting works the same way: appending an already-attached node *moves* it,
// so reordering the grid costs one append call and keeps every loaded
// thumbnail, presigned URL and selection state alive.
//
// `recs` here is this module's own copy of the list. app.js keeps its own as the
// source of truth for uploads and deletes; sharing one array made the two drift
// apart the moment either side filtered it.

const STAGGER_MAX = 30;   // only the first screenful gets the entrance

const LONG_PRESS_MS = 450;

export function createGallery({ backend, seen, onOpen, onSelect, sort = 'added' }) {
  const grid = $('grid');
  const tiles = new Map();        // base → <button>
  const signed = new Map();       // path → presigned URL
  let recs = [];
  let users = new Map();
  let me = null;
  let filter = null;              // uid, or null for everyone
  let firstPaint = true;

  let selecting = false;
  const picked = new Set();       // bases

  // Presigning every thumbnail up front would be a thousand HMAC chains at
  // boot. Sign as tiles approach the viewport instead.
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      loadThumb(e.target);
    }
  }, { rootMargin: '400px 0px' });

  async function loadThumb(tile) {
    const rec = tile._rec;
    const img = tile.querySelector('img');
    try {
      let url = signed.get(rec.thumbKey);
      if (!url) {
        url = await backend.urlFor(rec.thumbKey);
        signed.set(rec.thumbKey, url);
      }
      img.src = url;
    } catch {
      tile.classList.add('nothumb');
    }
  }

  function markOf(rec) {
    // Saved beats new: it's the terminal state, and something you downloaded
    // this session shouldn't still be asking for attention.
    if (seen.isSaved(rec)) return 'saved';
    if (seen.isNew(rec, me?.uid)) return 'new';
    return '';
  }

  function makeTile(rec) {
    // draggable=false plus a dragstart guard: without them a long-press starts
    // the browser's native image drag, which lifts the <img> into its own
    // compositing layer above everything — so the selection ring and the
    // highlighted border disappear underneath the thing being dragged.
    const img = el('img', { decoding: 'async', alt: '', draggable: 'false' });
    img.addEventListener('dragstart', (e) => e.preventDefault());
    img.addEventListener('load', () => img.classList.add('loaded'));

    const tile = el('button', { class: 'tile', type: 'button' },
      el('div', { class: 'shot' },
        img,
        el('span', { class: 'mark' }),
        el('span', { class: 'selbox' })),
      el('div', { class: 'frame' },
        el('span', { text: frameNo(rec.num) }),
        el('span', { class: 'fname', text: shortName(nameOf(users, rec.uid)) })));

    tile.style.setProperty('--person', colorFor(rec.uid));
    tile.dataset.state = markOf(rec);
    tile._rec = rec;
    tile.setAttribute('aria-label',
      `Frame ${frameNo(rec.num)} by ${nameOf(users, rec.uid)}`);

    // Long-press is the idiom people already know from their photo app, but
    // it's undiscoverable on its own — hence the Select button in the header
    // as well.
    let timer = null;
    let start = null;
    let longPressed = false;

    const cancel = () => { clearTimeout(timer); timer = null; };

    tile.addEventListener('pointerdown', (e) => {
      start = { x: e.clientX, y: e.clientY };
      longPressed = false;
      timer = setTimeout(() => {
        longPressed = true;
        if (!selecting) setSelecting(true);
        toggle(rec);
        navigator.vibrate?.(12);
      }, LONG_PRESS_MS);
    });
    tile.addEventListener('pointermove', (e) => {
      if (!start) return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel();
    });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
      tile.addEventListener(ev, cancel);
    }

    tile.addEventListener('click', () => {
      if (longPressed) { longPressed = false; return; }   // the press already acted
      if (selecting) toggle(rec);
      else onOpen(rec);
    });
    return tile;
  }

  // ── selection ────────────────────────────────────────────────────────────

  function paintSelection(base) {
    const tile = tiles.get(base);
    if (tile) tile.dataset.sel = picked.has(base) ? 'on' : '';
  }

  function toggle(rec) {
    if (picked.has(rec.base)) picked.delete(rec.base);
    else picked.add(rec.base);
    paintSelection(rec.base);
    onSelect?.(selectedRecs());
  }

  const selectedRecs = () => recs.filter((r) => picked.has(r.base));

  function setSelecting(on) {
    selecting = on;
    grid.classList.toggle('selecting', on);
    if (!on) {
      for (const base of picked) { picked.delete(base); paintSelection(base); }
    }
    onSelect?.(selectedRecs());
  }

  // Tapping the empty sheet around the photos leaves selection mode — the same
  // way tapping away dismisses anything else. Controls are excluded, or the
  // Cancel button would fight this handler for the same tap.
  document.addEventListener('click', (e) => {
    if (!selecting) return;
    if (e.target.closest('.tile, .sheethead, .dock, .filters, .sheet, .lightbox')) return;
    setSelecting(false);
  });

  function renderChips() {
    const counts = new Map();
    for (const r of recs) counts.set(r.uid, (counts.get(r.uid) ?? 0) + 1);

    const chip = (uid, label, n) => el('button', {
      class: 'chip',
      type: 'button',
      'aria-pressed': String(filter === uid),
      onclick: () => setFilter(filter === uid ? null : uid),
    }, el('span', { text: label }), el('span', { class: 'n', text: String(n) }));

    const all = chip(null, 'All', recs.length);
    all.style.setProperty('--person', 'var(--ink-dim)');

    const people = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || nameOf(users, a[0]).localeCompare(nameOf(users, b[0])))
      .map(([uid, n]) => {
        const c = chip(uid, nameOf(users, uid), n);
        c.style.setProperty('--person', colorFor(uid));
        return c;
      });

    $('filters').replaceChildren(all, ...people);
  }

  function visible() {
    return filter ? recs.filter((r) => r.uid === filter) : recs;
  }

  /** What "save all" would grab: unsaved, and not your own — you have those. */
  function pending() {
    return visible().filter((r) => r.uid !== me?.uid && !seen.isSaved(r));
  }

  function renderHeader() {
    const newCount = recs.filter((r) => seen.isNew(r, me?.uid)).length;
    const parts = [el('span', { text: plural(recs.length, 'frame') })];
    if (newCount) {
      parts.push(document.createTextNode(' · '),
                 el('b', { text: `${newCount} new` }));
    }
    $('galMeta').replaceChildren(...parts);

    // Nothing to save disables the button rather than removing it: it's the
    // control the whole app is built around, and a dock that grows and shrinks
    // as you save, filter or upload is harder to read than a greyed-out zero.
    // Staying put also keeps the legend's `↓ Save` row pointing at something.
    const n = pending().length;
    const btn = $('saveAllBtn');
    btn.textContent = `↓ Save ${n}`;
    btn.disabled = n === 0;
    // While selecting, the dock belongs to the selection actions; an album with
    // no frames at all has nothing for it to mean yet.
    if (!selecting) btn.hidden = recs.length === 0;

    $('galEmpty').hidden = recs.length > 0;
  }

  function applyFilter() {
    for (const tile of tiles.values()) {
      tile.hidden = filter !== null && tile._rec.uid !== filter;
    }
  }

  function setFilter(uid) {
    filter = uid;
    applyFilter();
    renderChips();
    renderHeader();
  }

  /** Move the existing tiles into `recs` order. No tiles are created. */
  function reorder() {
    grid.append(...recs.map((r) => tiles.get(r.base)).filter(Boolean));
  }

  function render(nextRecs, nextUsers, nextMe) {
    recs = [...nextRecs].sort(byMode(sort));
    users = nextUsers;
    me = nextMe;

    tiles.clear();
    picked.clear();
    io.disconnect();

    const frag = document.createDocumentFragment();
    recs.forEach((rec, i) => {
      const tile = makeTile(rec);
      if (firstPaint && i < STAGGER_MAX) {
        tile.classList.add('enter');
        tile.style.animationDelay = `${i * 12}ms`;
      }
      tiles.set(rec.base, tile);
      frag.append(tile);
    });

    grid.replaceChildren(frag);
    for (const tile of tiles.values()) io.observe(tile);

    firstPaint = false;
    setSelecting(false);
    applyFilter();
    renderChips();
    renderHeader();
  }

  return {
    render,
    setFilter,
    pending,
    visible,

    /**
     * 'added' (upload time) or 'taken' (EXIF, falling back to upload time).
     *
     * Frame numbers deliberately do *not* follow: they're an identity, printed
     * in the lightbox and baked into download filenames, so sorting by capture
     * date shows 007 next to 042 — which reads as "shot together, uploaded
     * weeks apart" rather than as a glitch.
     */
    setSort(next) {
      sort = next;
      recs.sort(byMode(sort));
      reorder();
    },

    setSelecting,
    selected: selectedRecs,
    isSelecting: () => selecting,

    /** Everything in the current view — so "select all" while filtered by a
        person means that person's photos, which is what you meant. */
    selectAll(on) {
      const vis = visible();
      for (const r of vis) {
        if (on) picked.add(r.base); else picked.delete(r.base);
        paintSelection(r.base);
      }
      onSelect?.(selectedRecs());
    },
    allSelected: () => {
      const vis = visible();
      return vis.length > 0 && vis.every((r) => picked.has(r.base));
    },

    /** Re-read marks from seen state without rebuilding anything. */
    refresh() {
      for (const tile of tiles.values()) tile.dataset.state = markOf(tile._rec);
      renderHeader();
    },

    /** A just-uploaded photo, straight into the grid — no reload. */
    add(rec) {
      const tile = makeTile(rec);
      tiles.set(rec.base, tile);
      recs.unshift(rec);
      io.observe(tile);
      if (sort === 'added') {
        grid.prepend(tile);          // newest by upload time, so it belongs first
      } else {
        // By capture date it could belong anywhere — a photo from day one
        // uploaded last.
        grid.append(tile);
        recs.sort(byMode(sort));
        reorder();
      }
      applyFilter();
      renderChips();
      renderHeader();
    },

    remove(base) {
      tiles.get(base)?.remove();
      tiles.delete(base);
      picked.delete(base);
      // Drop it from our own list too, or the chip counts and the lightbox's
      // page list keep the deleted photo.
      recs = recs.filter((r) => r.base !== base);
      // Frame numbers are positions in arrival order, so they close up.
      for (const tile of tiles.values()) {
        const f = tile.querySelector('.frame span');
        if (f) f.textContent = frameNo(tile._rec.num);
      }
      renderChips();
      renderHeader();
    },

    /** Names changed (rename, or a user file arrived late). */
    relabel(nextUsers) {
      users = nextUsers;
      for (const tile of tiles.values()) {
        const f = tile.querySelector('.fname');
        if (f) f.textContent = shortName(nameOf(users, tile._rec.uid));
      }
      renderChips();
    },
  };
}
