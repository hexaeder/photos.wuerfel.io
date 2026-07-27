// The album link is the whole credential. Everything the app needs to reach
// the bucket rides in the URL fragment, which never leaves the browser — the
// server (GitHub Pages) never sees it.
//
//   https://photos.wuerfel.io/#a=<base64url(JSON)>
//
// Payload, minted by tools/photoshare.py:
//   { v, t:'s3', ep, rg, b, p, k, s, n, ro? }

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

const REQUIRED = ['ep', 'rg', 'b', 'p', 'k', 's'];

function validate(a) {
  if (a.t && a.t !== 's3') throw new Error(`Unknown album type "${a.t}".`);
  const missing = REQUIRED.filter((f) => !a[f]);
  if (missing.length) throw new Error(`The link is missing: ${missing.join(', ')}.`);
  if (!a.p.endsWith('/')) a.p += '/';
  a.n ||= a.p.replace(/\/$/, '').split('/').pop();
  a.readonly = a.ro === 1 || a.ro === true;
  return a;
}

/** Pull `#a=…` out of any string that contains it (a URL, or just the hash). */
export function albumFromText(text) {
  const m = /[#&]a=([A-Za-z0-9\-_]+)/.exec(String(text).trim());
  if (!m) {
    throw new Error("That doesn't look like an album link — it should contain “#a=”.");
  }
  let raw;
  try {
    raw = decodeFragment(m[1]);
  } catch {
    throw new Error('The link is damaged. Copy it again — chat apps sometimes cut long links in half.');
  }
  return validate(raw);
}

/** The album in the current URL, or null if there isn't one. */
export function albumFromLocation() {
  if (!/[#&]a=/.test(location.hash)) return null;
  return albumFromText(location.hash);
}
