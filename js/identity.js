// Who you are, stored in localStorage and mirrored to users/<uid>.json.
//
// Identity is global rather than per-album: you're the same person on every
// trip. Only { uid, name } ever lives locally, so losing it costs a tap —
// everything else re-syncs from the bucket.

const LS_KEY = 'photoshare.me';

const ADJ = [
  'Wandering', 'Restless', 'Sunlit', 'Quiet', 'Wayward', 'Northbound',
  'Salt-Stained', 'Half-Awake', 'Barefoot', 'Windblown', 'Stubborn',
  'Sleepless', 'Late-Rising', 'Overpacked', 'Unhurried', 'Weatherproof',
];
const NOUN = [
  'Elk', 'Puffin', 'Heron', 'Marmot', 'Fox', 'Ibex', 'Otter', 'Raven',
  'Gull', 'Lynx', 'Badger', 'Crane', 'Seal', 'Hare', 'Owl', 'Stoat',
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export const randomName = () => `${pick(ADJ)} ${pick(NOUN)}`;

export function newUid() {
  const b = crypto.getRandomValues(new Uint8Array(3));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// ── person colours ───────────────────────────────────────────────────────
//
// Attribution is carried by colour, so two people must never end up looking
// *almost* the same — that's worse than looking identical, because you think
// you can tell them apart and can't.
//
// So colours come from 12 hues spaced 27° apart, and setPalette hands them out
// to spread the album's actual members as far apart as it can: with four
// friends they land ~90° apart, not at the 27° minimum. Each person's uid only
// sets their *preferred* hue, which breaks ties.
//
// Callers pass uids in join order (earliest upload first), which makes the
// assignment append-only — someone joining on day five never recolours anyone
// who was already there. Past twelve people the hues repeat at a darker
// lightness, which still reads as a different person at a glance.
//
// Hues 5°–40° are skipped: that band belongs to the safelight accent, which
// means "new" and must not be mistaken for a person.

const HUES = 24;        // 13.5° apart
const MIN_GAP = 2;      // never place two people closer than 27°
const TIERS = [[60, 64], [78, 44], [38, 80]];   // saturation %, lightness %

function hash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function color(hueIndex, tier) {
  const [sat, light] = TIERS[Math.min(tier, TIERS.length - 1)];
  let hue = Math.round(hueIndex * (324 / HUES));
  if (hue >= 5) hue += 36;
  return `hsl(${hue} ${sat}% ${light}%)`;
}

let assigned = new Map();

/** Circular distance between two hue indices. */
const gap = (a, b) => {
  const d = Math.abs(a - b) % HUES;
  return Math.min(d, HUES - d);
};

/**
 * Assign every member a colour. `uids` must be in join order — earliest
 * uploader first — so that adding someone appends rather than reshuffles.
 */
export function setPalette(uids) {
  assigned = new Map();
  let tier = 0;
  let taken = [];

  for (const uid of [...new Set(uids)]) {
    const preferred = hash32(uid) % HUES;

    // Walk outward from the preferred hue and keep the one sitting furthest
    // from everyone already placed. Strict > means the preferred hue wins
    // ties, so a lone user still gets the colour their uid implies.
    const bestIn = (placed) => {
      let best = preferred;
      let bestGap = -1;
      for (let k = 0; k < HUES; k++) {
        const hue = (preferred + k) % HUES;
        const spread = placed.length ? Math.min(...placed.map((t) => gap(hue, t))) : HUES;
        if (spread > bestGap) { bestGap = spread; best = hue; }
      }
      return { best, bestGap };
    };

    let { best, bestGap } = bestIn(taken);
    // Rather than squeeze someone in at a hue nobody could tell apart, move to
    // a darker tier and start the circle again.
    if (bestGap < MIN_GAP && tier < TIERS.length - 1) {
      tier++;
      taken = [];
      ({ best } = bestIn(taken));
    }

    taken.push(best);
    assigned.set(uid, color(best, tier));
  }
}

export const colorFor = (uid) =>
  assigned.get(uid) ?? color(hash32(uid) % HUES, 0);

export function loadMe() {
  try {
    const me = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    return me?.uid && me?.name ? me : null;
  } catch {
    return null;
  }
}

export function saveMe(me) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ uid: me.uid, name: me.name }));
  } catch {
    /* Private mode, or storage full. The session still works; the next visit
       just asks who you are again. */
  }
  return me;
}

// users/<uid>.json is the public record one person asserts about themselves and
// about the photos they uploaded:
//
//   { uid, name, updatedAt, photos: { <base>: { captured } } }
//
// Name and photo metadata live together because they share an audience and a
// lifecycle — everyone reads them once at boot, and both change rarely. Seen
// state deliberately does not join them (state/<uid>.json): only its owner
// reads it, it is rewritten every couple of seconds while saving, and it grows
// with the album rather than with this person's uploads.

/** Everyone who has ever written to this album: uid → { uid, name, photos }. */
export async function loadUsers(backend) {
  const entries = await backend.list('users/');
  const users = new Map();

  await Promise.all(entries
    .filter((e) => e.name.endsWith('.json'))
    .map(async (e) => {
      const uid = e.name.replace(/\.json$/, '');
      const rec = await backend.getJSON(e.path).catch(() => null);
      const name = rec?.name?.trim();
      users.set(uid, {
        uid,
        name: name || uid,
        // Absent on records written before capture dates existed, and on
        // anything hand-written into the bucket.
        photos: (rec?.photos && typeof rec.photos === 'object') ? rec.photos : {},
      });
    }));

  return users;
}

/**
 * Write one person's whole record. Only its owner ever calls this.
 *
 * Merged against the remote copy rather than overwriting it: the same person on
 * a second device may have added photos since this one loaded, and capture
 * dates are append-only per key so a union is simply correct. The name is
 * last-write-wins, which is the behaviour you want anyway.
 *
 * That leaves the race narrowed to the gap between this read and its put, so
 * callers must still write **once per upload batch** — three of `upload.js`'s
 * parallel PUTs each doing read-modify-write on this key would clobber.
 */
export async function writeUser(backend, rec) {
  const path = `users/${rec.uid}.json`;
  const remote = await backend.getJSON(path).catch(() => null);
  return backend.putJSON(path, {
    uid: rec.uid,
    name: rec.name,
    updatedAt: new Date().toISOString(),
    photos: { ...(remote?.photos ?? {}), ...(rec.photos ?? {}) },
  });
}

/** Display name for a uid, falling back to the uid itself. */
export const nameOf = (users, uid) => users.get(uid)?.name || uid;

/** First name only — what fits under a 92px thumbnail without ellipsis. */
export const shortName = (name) => (name || '').trim().split(/\s+/)[0].slice(0, 11) || name;
