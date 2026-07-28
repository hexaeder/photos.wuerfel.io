// Just enough EXIF to answer "when was this taken".
//
// Nothing else in the app reads image metadata, and a general parser would be
// several hundred lines for tags nobody wants — so this walks JPEG segments to
// the Exif APP1 block, then the TIFF IFDs to three date tags, and stops.
//
// JPEG only, by way of the SOI check rather than a MIME sniff: iOS transcodes
// HEIC to JPEG in the picker and Android hands over the original JPEG, so that
// covers every real upload path. Anything else returns null, and the caller
// falls back to the upload time.
//
// Everything here reads attacker-supplied bytes at computed offsets, so the
// whole thing runs inside one try/catch and a truncated or hostile file is
// answered with null rather than an exception.

const HEAD_BYTES = 256 * 1024;   // APP1 sits at the very start and caps at 64K

const TAG_DATETIME = 0x0132;             // IFD0, "file changed" — last resort
const TAG_EXIF_IFD = 0x8769;             // pointer to the Exif sub-IFD
const TAG_DATETIME_ORIGINAL = 0x9003;    // shutter time — what we actually want
const TAG_DATETIME_DIGITIZED = 0x9004;
const TAG_OFFSET_ORIGINAL = 0x9011;      // EXIF 2.31 UTC offset, e.g. "+02:00"

/** Byte offset of the TIFF header inside an Exif APP1 segment, or -1. */
function findExif(view) {
  if (view.getUint16(0) !== 0xFFD8) return -1;          // not a JPEG at all
  let p = 2;
  while (p + 4 <= view.byteLength) {
    if (view.getUint8(p) !== 0xFF) return -1;           // desynced; give up
    const marker = view.getUint8(p + 1);
    if (marker === 0xDA) return -1;                     // start of scan: no EXIF
    const size = view.getUint16(p + 2);
    if (size < 2) return -1;
    // APP1 whose payload begins "Exif\0\0" is the one; APP1 is also used for XMP.
    if (marker === 0xE1 && p + 10 <= view.byteLength
        && view.getUint32(p + 4) === 0x45786966 && view.getUint16(p + 8) === 0) {
      return p + 10;
    }
    p += 2 + size;
  }
  return -1;
}

/** tag → byte offset of its 12-byte directory entry. */
function entriesAt(view, tiff, ifd, little) {
  const found = new Map();
  const count = view.getUint16(tiff + ifd, little);
  for (let i = 0; i < count; i++) {
    const e = tiff + ifd + 2 + i * 12;
    if (e + 12 > view.byteLength) break;
    found.set(view.getUint16(e, little), e);
  }
  return found;
}

/** An ASCII value, read inline when it fits in the entry and out-of-line when not. */
function asciiAt(view, tiff, e, little) {
  const n = view.getUint32(e + 4, little);
  const at = n <= 4 ? e + 8 : tiff + view.getUint32(e + 8, little);
  let s = '';
  for (let i = 0; i < n && at + i < view.byteLength; i++) {
    const c = view.getUint8(at + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

const MIN_MS = Date.UTC(1990, 0, 1);
const DAY_MS = 86400000;

function parseExifDate(text, offset) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(text || '');
  if (!m) return null;
  const [Y, M, D, h, min, s] = m.slice(1).map(Number);

  // DateTimeOriginal is wall-clock time at the camera with no zone attached.
  // EXIF 2.31 added OffsetTimeOriginal and iPhones write it; without it the
  // viewer's own zone is the least-wrong guess, and for ordering photos within
  // one trip it makes no difference either way.
  const off = /^([+-])(\d{2}):(\d{2})$/.exec(offset || '');
  const ms = off
    ? Date.UTC(Y, M - 1, D, h, min, s)
      - (off[1] === '-' ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3])) * 60000
    : new Date(Y, M - 1, D, h, min, s).getTime();

  // A camera with a dead clock battery reports 1980, and a misread tag reports
  // nonsense. Either way the upload time is the better answer, so say null.
  if (!Number.isFinite(ms) || ms < MIN_MS || ms > Date.now() + DAY_MS) return null;
  return ms;
}

/**
 * Epoch ms the photo was taken, or null if the file doesn't say.
 *
 * Null is an ordinary answer, not a failure: screenshots, anything a messenger
 * app has been through, and every non-JPEG land here.
 */
export async function capturedAt(file) {
  try {
    const view = new DataView(await file.slice(0, HEAD_BYTES).arrayBuffer());
    if (view.byteLength < 16) return null;

    const tiff = findExif(view);
    if (tiff < 0) return null;

    const order = view.getUint16(tiff, false);
    if (order !== 0x4949 && order !== 0x4D4D) return null;   // "II" / "MM"
    const little = order === 0x4949;
    if (view.getUint16(tiff + 2, little) !== 42) return null;

    const ifd0 = entriesAt(view, tiff, view.getUint32(tiff + 4, little), little);

    let exif = new Map();
    const ptr = ifd0.get(TAG_EXIF_IFD);
    if (ptr) {
      const at = view.getUint32(ptr + 8, little);
      if (at > 0 && tiff + at + 2 <= view.byteLength) {
        exif = entriesAt(view, tiff, at, little);
      }
    }

    const read = (tag) => {
      const e = exif.get(tag) ?? ifd0.get(tag);
      return e ? asciiAt(view, tiff, e, little) : '';
    };

    const offset = read(TAG_OFFSET_ORIGINAL);
    for (const tag of [TAG_DATETIME_ORIGINAL, TAG_DATETIME_DIGITIZED, TAG_DATETIME]) {
      const ms = parseExifDate(read(tag), offset);
      if (ms) return ms;
    }
    return null;
  } catch {
    return null;      // truncated, hostile, or simply not what we expected
  }
}
