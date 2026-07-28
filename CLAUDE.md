# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static photo-album web app (plain ES modules, no build step, no npm, no framework, no tests)
served from GitHub Pages at `photos.wuerfel.io`, plus a Python CLI that provisions albums in a
Wasabi S3 bucket. The browser talks to Wasabi directly with SigV4 signing; **there is no server
of ours after page load**.

`DESIGN.md` is the authoritative design document — long, current, and states *why* for nearly
every decision below. Read the relevant section before changing behaviour it describes.

## Commands

```bash
# Serve locally. crypto.subtle / navigator.share need a secure context;
# localhost counts, file:// does not. Append a real album fragment to the URL.
python3 -m http.server 8000        # then http://localhost:8000/#<slug>.<keyid>.<secret>

# CLI (uv shebang resolves boto3; needs the `op` CLI for 1Password creds)
./tools/photoshare.py list
./tools/photoshare.py create "Norway 2026"     # prints the link ONCE, never stored
./tools/photoshare.py info <slug>
./tools/photoshare.py link <slug>              # re-issue; rotates key, kills old link
./tools/photoshare.py extend <slug> 30d        # move upload deadline, link survives
./tools/photoshare.py revoke <slug>            # kill links, keep photos
./tools/photoshare.py rm <slug>                # 💸 deletes objects (90-day min charge)
./tools/photoshare.py check --revoke           # quota watchdog, exit 2 if over
```

`selftest` and `init` hit the live Wasabi account and create/delete real IAM users — don't run
them casually. Config is read from `$PHOTOSHARE_CONFIG`, then `tools/config.toml`, then
`~/.config/photoshare.toml`; it holds 1Password *references*, not secrets, and is gitignored.

Deploy is `git push` to `main` — Pages serves the repo root as-is (`CNAME`, `.nojekyll`).
There is nothing to build, so a broken commit is a broken site.

## Architecture

The album link **is** the credential: `#<slug>.<keyid>.<secret>[.r]` in the URL *fragment*, so it
never reaches GitHub's logs. Each album is one bucket prefix plus a dedicated IAM sub-user whose
inline policy allows exactly that prefix, with `PutObject`/`DeleteObject` in a separate
time-limited statement. Revocation = delete the sub-user.

```
albums/<slug>/
  album.json          { schemaVersion, slug, title, createdAt }  — title source of truth
  photos/<ts>-<uid>-<hash>.<ext>    original bytes, untouched
  mid/<ts>-<uid>-<hash>.jpg         ~2048px JPEG — the lightbox
  thumbs/<ts>-<uid>-<hash>.jpg      ~512px JPEG — the grid
  users/<uid>.json    { uid, name, updatedAt }
  state/<uid>.json    { uid, lastSeenAt, downloaded: [hash…] }
```

**Originals are never re-encoded** — there is no downscale option, and that is
deliberate (DESIGN.md §11.1): the app exists so people get the real file instead
of what a messenger app left of it, and it's also the only reason EXIF survives.
Nothing but an explicit download touches `photos/`; browsing is served entirely
by the two derivatives. `mid/` is allowed to be absent (original already under
the cap, or an undecodable file), so the lightbox tiers thumb → mid → original
and treats a miss as a normal fallback. Any new code path that deletes a photo
must remove all three keys.

Module map: `app.js` (boot, screen routing, bulk save, error text) → `album.js` (link decode),
`backend-s3.js` (the only place that speaks S3), `photos.js` (filename → record),
`identity.js` (uid/name/colour), `seen.js`, `gallery.js`, `lightbox.js`, `upload.js`,
`share.js`, `ui.js` (`el`/`toast`/`confirmSheet`/`taskSheet`). `lib/aws4fetch.js` is the single
vendored dependency. `spike/` is the frozen Phase-0 proof-of-concept; don't edit it.

## Invariants that span files

- **The filename is the index.** `<uploadedMs>-<uid>-<sha256[0:8]>.<ext>` carries uploader,
  time, and content hash, so one `ListObjectsV2` rebuilds the whole album and the hash gives free
  dedup. The `NAME` regex in `js/photos.js` and `baseFor`/upload naming must stay in agreement.
  Never add a shared index file.
- **One writer per object.** `users/<uid>.json` and `state/<uid>.json` are written only by their
  owner. S3 has no transactions; a shared file would silently clobber. Any new per-user data
  follows the same rule.
- **`SITE` in `js/album.js` mirrors `SITE_BUCKET`/`SITE_REGION` in `tools/photoshare.py`.**
  Change one, change the other, or compact links point at the wrong bucket. The CLI degrades to
  the long `#a=<base64url(JSON)>` form when its config disagrees, and `album.js` must keep
  decoding that form forever — old links exist.
- **Every list call sends `prefix`.** The IAM policy's `s3:prefix` condition is what fences an
  album key to its own prefix; a list without it is denied. `backend-s3.js` also paginates —
  `ListObjectsV2` caps at 1000 keys and dropping the loop truncates the gallery silently.
- **`fetch` doesn't throw on 4xx.** `backend-s3.js` wraps every response, parses S3's XML
  `<Code>`, and attaches `.status`/`.code`; `explain()` in `app.js` turns those into instructions
  (clock skew, revoked link, offline). Keep new failure paths inside that shape.
- **Read-only is enforced twice.** `album.readonly` (the `.r` suffix / `ro` flag) hides write UI,
  but a 403 must still be handled gracefully — an expired upload window produces one on a link
  that had no flag.
- **Never `await` before `navigator.share()`.** iOS drops the user gesture and throws
  `NotAllowedError`. Bulk save therefore fetches bytes on an earlier tap and shares in batches of
  `BATCH`, one tap each. Branch on `canShareFiles()`, never on the user agent.
- **Mobile memory.** Hash and decode sequentially, `close()` every `ImageBitmap`, cap concurrent
  PUTs/GETs at ~3. Twenty full-size decodes crash mobile Safari.
- **localStorage is never the only home for anything.** iOS wipes it after 7 days of no visits;
  only `{uid, name}` may be lost, and the "continue as" list in the identity screen is the
  recovery path.

## UI conventions

Screens are sections toggled by `body[data-screen]` (`boot`/`link`/`identity`/`gallery`) via
`show()`; the lightbox and sheets are overlays on top. Tiles are built once and filtered by
toggling `hidden` — no re-render. Thumbnails are presigned lazily by an `IntersectionObserver`.
`[hidden] { display: none !important }` in `app.css` is structural: any component-level `display`
rule would otherwise override the UA default and render hidden elements.

Visual language is a photographic contact sheet: warm near-black ground, hairline rules,
monospace frame numbers, `--safelight` (#E8622B) as the *only* loud colour, and one hue per
person from `setPalette()` in `identity.js` — which spaces the album's actual members as far
apart as possible and deliberately avoids the safelight band. Tokens live at the top of
`app.css`. Guard against horizontal overflow (`min-width: 0` on flex/grid children); `app.js`
warns in the console when the page exceeds the viewport.
