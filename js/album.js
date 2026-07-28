// The album link is the whole credential. Everything the app needs to reach
// the bucket rides in the URL fragment, which never leaves the browser — the
// server (GitHub Pages) never sees it.
//
// Two forms, both minted by tools/photoshare.py and both accepted here:
//
//   compact   #<slug>.<keyid>.<secret>[.r]          ~100 chars
//   long      #a=<base64url(JSON)>                  ~330 chars
//
// The compact form is the default. It carries only what varies — slug and
// credential — and reconstructs the rest from SITE below. The long form spells
// out { v, t:'s3', ep, rg, b, p, k, s, n, ro? } and is what a deployment
// against some other bucket gets; it is also every link issued before this
// change, so its decoder stays here permanently.

// Mirrored in tools/photoshare.py (SITE_BUCKET / SITE_REGION). The CLI falls
// back to the long form when its config names a different bucket, so these two
// only ever have to agree for *this* deployment.
const SITE = { b: 'photoshare-wuerfel', rg: 'eu-central-2' };

const ALBUM_ROOT = 'albums/';

/** base64url → object. Not cosmetic: Wasabi secrets contain '/' and '+'. */
function decodeFragment(blob) {
  const b64 = blob.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  // Decode as UTF-8 rather than trusting atob's byte-per-char output: album
  // titles have umlauts in them, and this survives a CLI that stops escaping
  // non-ASCII.
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

// A compact fragment: lowercase slug, the key id, the secret, optional '.r'.
// Anchored, so a dotted word elsewhere in a pasted message cannot masquerade
// as a link — the failure mode to avoid is a confident wrong decode, not a
// rejected paste.
const COMPACT = /^([a-z0-9][a-z0-9-]*)\.([A-Za-z0-9]{16,})\.([A-Za-z0-9_-]{20,})(\.r)?$/;

/** Compact triple → the same shape the long form decodes to. */
function expandCompact(m) {
  const [, slug, key, secret, ro] = m;
  return {
    v: 1,
    t: 's3',
    ep: `https://s3.${SITE.rg}.wasabisys.com`,
    rg: SITE.rg,
    b: SITE.b,
    p: `${ALBUM_ROOT}${slug}/`,
    k: key,
    // Reverse of the CLI's substitution. '-' and '_' are not in the base64
    // alphabet a Wasabi secret is drawn from, so this cannot corrupt one.
    s: secret.replace(/-/g, '+').replace(/_/g, '/'),
    ...(ro ? { ro: 1 } : {}),
  };
}

const REQUIRED = ['ep', 'rg', 'b', 'p', 'k', 's'];

function validate(a) {
  if (a.t && a.t !== 's3') throw new Error(`Unknown album type "${a.t}".`);
  const missing = REQUIRED.filter((f) => !a[f]);
  if (missing.length) throw new Error(`The link is missing: ${missing.join(', ')}.`);
  if (!a.p.endsWith('/')) a.p += '/';
  a.slug = a.p.replace(/\/$/, '').split('/').pop();
  // A compact link carries no title; the real one arrives from album.json once
  // the backend is up (js/app.js). Until then the slug reads perfectly well.
  a.n ||= a.slug;
  a.readonly = a.ro === 1 || a.ro === true;
  return a;
}

/**
 * The album-bearing fragment of any string that has one — a whole pasted URL,
 * or just the hash — including its leading '#', which is the form that belongs
 * in the address bar. Null if there isn't one.
 */
export function fragmentFromText(text) {
  const s = String(text).trim();
  const long = /[#&]a=([A-Za-z0-9\-_]+)/.exec(s);
  if (long) return `#a=${long[1]}`;
  const i = s.indexOf('#');
  return i >= 0 && COMPACT.test(s.slice(i + 1)) ? s.slice(i) : null;
}

/** Pull an album out of any string that contains a link. */
export function albumFromText(text) {
  const frag = fragmentFromText(text);
  if (!frag) {
    throw new Error("That doesn't look like an album link — it should have a “#” in it.");
  }
  let raw;
  try {
    const compact = COMPACT.exec(frag.slice(1));
    raw = compact ? expandCompact(compact) : decodeFragment(frag.slice(3));
  } catch {
    throw new Error('The link is damaged. Copy it again — chat apps sometimes cut long links in half.');
  }
  return validate(raw);
}

/** The album in the current URL, or null if there isn't one. */
export function albumFromLocation() {
  return fragmentFromText(location.hash) ? albumFromText(location.hash) : null;
}
