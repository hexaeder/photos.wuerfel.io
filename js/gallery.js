import { $, el, plural } from './ui.js';
import { colorFor, nameOf, shortName } from './identity.js';
import { frameNo } from './photos.js';

// Tiles are built once and filtering toggles `hidden`. No re-render, no
// virtual DOM, and it stays smooth at a thousand photos.

const STAGGER_MAX = 30;   // only the first screenful gets the entrance

export function createGallery({ backend, seen, onOpen, onSaveAll }) {
  const grid = $('grid');
  const tiles = new Map();        // base → <button>
  const signed = new Map();       // path → presigned URL
  let recs = [];
  let users = new Map();
  let me = null;
  let filter = null;              // uid, or null for everyone
  let firstPaint = true;

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
    const img = el('img', { decoding: 'async', alt: '' });
    img.addEventListener('load', () => img.classList.add('loaded'));

    const tile = el('button', { class: 'tile', type: 'button' },
      el('div', { class: 'shot' }, img, el('span', { class: 'mark' })),
      el('div', { class: 'frame' },
        el('span', { text: frameNo(rec.num) }),
        el('span', { class: 'fname', text: shortName(nameOf(users, rec.uid)) })));

    tile.style.setProperty('--person', colorFor(rec.uid));
    tile.dataset.state = markOf(rec);
    tile._rec = rec;
    tile.setAttribute('aria-label',
      `Frame ${frameNo(rec.num)} by ${nameOf(users, rec.uid)}`);
    tile.addEventListener('click', () => onOpen(rec));
    return tile;
  }

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

    const n = pending().length;
    const btn = $('saveAllBtn');
    btn.hidden = n === 0;
    btn.textContent = `↓ Save ${n}`;

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

  function render(nextRecs, nextUsers, nextMe) {
    recs = nextRecs;
    users = nextUsers;
    me = nextMe;

    tiles.clear();
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
    applyFilter();
    renderChips();
    renderHeader();
  }

  return {
    render,
    setFilter,
    pending,
    visible,

    /** Re-read marks from seen state without rebuilding anything. */
    refresh() {
      for (const tile of tiles.values()) tile.dataset.state = markOf(tile._rec);
      renderHeader();
    },

    /** A just-uploaded photo, straight into the grid — no reload. */
    add(rec) {
      const tile = makeTile(rec);
      tiles.set(rec.base, tile);
      grid.prepend(tile);
      io.observe(tile);
      applyFilter();
      renderChips();
      renderHeader();
    },

    remove(base) {
      tiles.get(base)?.remove();
      tiles.delete(base);
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
