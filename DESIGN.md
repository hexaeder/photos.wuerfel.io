# Photoshare — Design Document

A static (HTML + JS only) web app, hosted on GitHub Pages, that turns a Wasabi
bucket prefix into a shared trip-photo album for a group of friends on mixed
iOS/Android devices. Album lifecycle is managed by a small Python CLI that reads
a scoped Wasabi admin key from 1Password.

**Status:** live. CLI implemented against `photoshare-wuerfel` (`eu-central-2`),
security model verified on hardware (§2.2), and the web app built and deployed
to `photos.wuerfel.io` — the whole loop, identity through bulk download (§10).
Tested on iOS Safari and on Android; see §7.5 for the one browser class where
saving to the gallery is not possible.

---

## 1. Verdict

Yes, and Wasabi makes it *substantially* better than the Nextcloud version of
this idea.

| Feature | Verdict |
|---|---|
| Static site on GitHub Pages, no backend of your own | ✅ Yes |
| Bake storage credentials into a shareable URL | ✅ Yes (URL fragment) |
| Browser writes directly to storage (CORS) | ✅ **Works with zero configuration** |
| Credentials scoped to one album, can't touch the rest of the account | ✅ Yes (IAM sub-user + prefix policy) |
| **Revoke a single album's link without touching others** | ✅ Yes — impossible with Nextcloud shares |
| CLI to list / create / revoke albums from 1Password creds | ✅ Yes, implemented |
| Persistent identity + optional name, autopicked otherwise | ✅ Yes, with an iOS caveat (§9.1) |
| Native photo picker on phones | ✅ Yes, genuinely native on both platforms |
| Gallery tagged by uploader, rename, identity dropdown | ✅ Yes |
| Per-user "already downloaded" state, stored in the bucket | ✅ Yes |
| "What's new since my last visit" | ✅ Yes |
| Download all / sync | ✅ Yes |
| Save directly into the phone's photo gallery | ✅ iOS Safari and Android Chrome — **browser-dependent**, see §7.5 |

Every row above was measured against the live account and real phones, not
inferred. The one qualification is the last: saving into the gallery needs Web
Share for files, which Android WebView browsers (DuckDuckGo and most non-Chrome
Android browsers) do not implement. They download to Downloads instead. No page
can work around that — §7.5 covers what the app does about it.

### 1.1 The CORS blocker is gone

The Nextcloud design died on CORS: browsers refuse to let JS from
`photos.wuerfel.io` read a response from another origin unless that origin sends
`Access-Control-Allow-*` headers, and Nextcloud doesn't send them on public
shares — with no fix available unless you control the server.

Wasabi's behaviour is the opposite, and it's unusually convenient. Wasabi
[does not support `PutBucketCors`][wasabi-cors] — there is nothing to
configure — because it **unconditionally returns permissive CORS headers**
whenever a request carries an `Origin` header, and answers `OPTIONS` preflights
on buckets and objects:

```
Access-Control-Allow-Origin:   *
Access-Control-Allow-Headers:  *
Access-Control-Allow-Methods:  GET, HEAD, POST, PUT, DELETE, MOVE, OPTIONS
Access-Control-Expose-Headers: *
Access-Control-Max-Age:        86400
```

That is everything the app needs — `PUT` for uploads, `GET` for downloads,
`ETag` readable from JS — with no setup step and no server of yours involved.
The single hardest problem in the previous design costs nothing here.

The flip side: you cannot restrict *which* origins use your bucket. That's fine.
Access is gated by request signatures, not by origin — an attacker who has your
credentials doesn't need a browser, and one who doesn't have them gains nothing
from being allowed to ask.

### 1.2 What Wasabi adds: real revocation

A Nextcloud public share is one capability for the whole folder. Wasabi's
[IAM API][wasabi-iam] is fully supported at `https://iam.wasabisys.com`
(`CreateUser`, `PutUserPolicy`, `CreateAccessKey`, `DeleteUser`, …), so each
album gets its **own sub-user** whose inline policy allows exactly one prefix.

This buys you two things the Nextcloud design could never have:

- **Per-album revocation.** Delete the sub-user and that link dies instantly,
  while every other album keeps working. Free and reversible (re-issue a new
  link any time).
- **Blast-radius containment.** A leaked link exposes one trip's photos. It
  cannot list your other albums, cannot touch other buckets, cannot reach IAM.

### 1.3 What I checked and rejected

**STS temporary credentials.** Wasabi [supports `AssumeRole`][wasabi-sts], which
would be the textbook answer — short-lived credentials instead of long-lived
keys in a URL. But the **maximum session duration is 12 hours**, and a trip album
link needs to work for months. Dead end. Long-lived sub-user keys plus cheap
revocation is the right trade here.

**A bucket per album.** You said bucket juggling is more annoying than making a
Nextcloud share, and you're right to avoid it: Wasabi's 90-day minimum storage
duration (§3) makes bucket churn mildly expensive, and you'd hit account bucket
limits eventually. One bucket, one prefix per album, one IAM user per prefix.

---

## 2. Security model

A static site has no secrets: any credential the page uses is present in every
visitor's browser. So the album link is a **bearer capability** — whoever holds
it has access.

Compared to the Nextcloud share link you use today, this is strictly better on
every axis except one:

| | Nextcloud share link | Photoshare album link |
|---|---|---|
| Anyone with the link has access | yes | yes |
| Revoke one album | delete + recreate the share | `photoshare revoke <slug>`, instant |
| Revoke without breaking other albums | n/a | ✅ |
| Can reach other albums / other data | folder only | prefix only, enforced by IAM |
| Can delete files | yes, anyone's | yes, anyone's — until `--expires` lapses |
| Recoverable after a delete | no | only with versioning — **off** on this bucket |
| Credential visible in URL | token | access key + secret |

The last row is the one downside, and it's cosmetic rather than substantive: a
Nextcloud share token is equally a secret in a URL. What matters is what the
secret can *do*, and here it's fenced into one prefix.

Practical rules that follow:

- **Fragment, never query string.** `#a=...` is never sent to a server, so the
  credentials stay out of GitHub's access logs and out of `Referer` headers.
  They will still land in browser history and in whatever chat app you shared
  through — unavoidable, and identical to your current workflow.
- **Base64 is encoding, not encryption.** Assume anyone with the URL can read
  the key in two seconds.
- **Identity is self-asserted.** Anyone can claim to be anyone. Fine among
  friends; just never build anything that depends on it being true. In
  particular the UI does **not** restrict deletion to your own photos (§7.2) —
  a fence built on self-asserted identity would only be theatre, since the IAM
  policy grants `s3:DeleteObject` across the whole prefix to every holder of
  the link.
- **Issue view-only links for people who only want to look**
  (`create --readonly-link`). Costs one extra IAM user and removes delete risk
  for most of the group.
- **Versioning is currently off** on `photoshare-wuerfel`, by choice. That means
  a delete is final. It's a defensible call because `DeleteObject` sits in the
  same expiring statement as `PutObject`, so the window in which anyone *can*
  delete is the same 30 days as the upload window. If you ever want the undo,
  enable it in the console — given the 90-day minimum you're paying for the
  deleted bytes regardless.
- **Per-user sync state is readable by everyone in the album** — it lives in the
  shared prefix. "Hans downloaded 47 photos" is visible to the group.
- **Originals keep their GPS EXIF, deliberately** (§7.1). Where a photo was
  taken is useful metadata and the album is for friends, so it stays. The
  consequence to be aware of rather than fix: everyone holding the link can read
  it, including for photos shot at home, and the link is a bearer capability
  that may outlive your intent for it.

### 2.1 The IAM policy

This is the load-bearing piece of the whole security model:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListOwnAlbumOnly",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::photoshare-wuerfel",
      "Condition": {"StringLike": {"s3:prefix": ["albums/norway-2026/*"]}}
    },
    {
      "Sid": "ReadOwnAlbum",
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::photoshare-wuerfel/albums/norway-2026/*"
    },
    {
      "Sid": "WriteOwnAlbum",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::photoshare-wuerfel/albums/norway-2026/*",
      "Condition": {"DateLessThan": {"aws:CurrentTime": "2026-08-26T00:00:00Z"}}
    }
  ]
}
```

Two things carry the weight here.

`ListBucket` is granted on the **bucket**, not the prefix — that's how S3 works,
and without the `s3:prefix` condition the key could enumerate every album you
have. The condition is what makes the fence real. The web app must therefore
always send a `prefix` parameter on list calls, which the adapter (§7.1) does.

Read and write are **separate statements** so the expiry gates uploads only
(§2.3). Once the deadline passes the gallery still works and uploads stop. A
view-only link is the same policy with the third statement omitted entirely.

### 2.2 What can the album key in the URL actually reach?

**Only that one album prefix. Nothing else — and this is enforced by Wasabi, not
by the app.**

> **Verified empirically on 2026-07-27** against the live `photoshare-wuerfel`
> account via `photoshare.py selftest`. All three fences below hold: an album key
> could not read another album's objects, could not enumerate the bucket, and
> could not write after its expiry. These are measurements, not inferences from
> S3-compatibility — re-run `selftest` if Wasabi ever changes its policy engine.

IAM is default-deny: anything not explicitly allowed is refused. The album
policy above grants exactly two things, so a holder of the link *cannot*:

| | Why |
|---|---|
| Read or write another album | `Resource` names one prefix; `albums/other/*` isn't in it |
| List the bucket at all without a matching prefix | the `s3:prefix` condition fails → denied |
| Touch your backup buckets | those ARNs appear nowhere in the policy |
| Create users, keys, or policies | no `iam:` action is granted |
| See billing, or your account at large | same |

So yes — to answer the question directly: **you can create a Wasabi user that
can only ever access one bucket**, and this design goes further by fencing it to
one *prefix within* one bucket. Your 500 GB of backups are unreachable from an
album link even if the link is posted publicly.

What a link holder *can* do inside their own album is read, upload, and
**delete**. Deletion is the meaningful residual risk, and bucket versioning
(§4.1) is the mitigation: a delete writes a marker, the bytes remain, and you
can restore. For people who only need to look, issue a view-only link
(`create --readonly-link`), whose policy omits `PutObject`/`DeleteObject`
entirely.

### 2.3 Can someone upload 1000 TB and stick me with the bill?

Short answer: **you cannot cap your own account, but you can make the upload
window close by itself — which is better than a quota anyway.**

#### Why there's no quota to set

- **No per-bucket quota, and no self-service account quota.** Storage quotas
  exist only in [Wasabi Account Control Manager][wacm], which is a
  reseller/MSP tool: a *parent* Control Account assigns a quota *to* a
  sub-account, and "a Sub-Account has access to the Wasabi Console but not to
  WACM". So the quota is a billing-allocation feature for people reselling
  storage, not a safety cap you can put on yourself. As an ordinary
  pay-as-you-go customer you have no equivalent knob — confirmed, and it's a
  real gap.
- **IAM cannot limit upload size.** Policy conditions evaluate request metadata,
  [not object size or content][aws-size]. There is no condition key for "max
  bytes" on `PutObject`, on AWS or on Wasabi.
- **Client-side limits are meaningless here.** The browser holds the secret key,
  so any check the app performs can be bypassed by signing requests directly.
  Anything enforceable must be server-side, and server-side has no such knob.

**Right-sizing the actual risk.** 1000 TB is not physically reachable — that's
~2.5 years of saturated gigabit upload. The realistic worst case is bounded by
bandwidth and by how fast you notice:

| | Uploaded | Committed cost (90-day minimum, ~$7/TB/mo) |
|---|---|---|
| Your existing headroom | first ~500 GB | **$0** — you already pay the 1 TB minimum |
| 1 hour @ 1 Gbit/s | ~0.44 TB | ~$9 |
| 1 day @ 1 Gbit/s | ~10 TB | ~$210 |
| 1 week unnoticed | ~75 TB | ~$1,500 |

Two things soften this considerably. First, you're at 500 GB against a 1 TB
minimum, so the **first ~500 GB of abuse is literally free** — an attacker has
to get past your existing headroom before it costs a cent. Second, the 90-day
minimum duration means damage is *committed* the moment bytes land, so deleting
fast doesn't refund it — which is precisely why detection latency, not cleanup
speed, is the variable that matters.

#### The better control: a self-closing upload window

IAM policies support time conditions, so the album policy splits read from write
and gates **only the write** on a deadline:

```json
{
  "Sid": "WriteOwnAlbum",
  "Effect": "Allow",
  "Action": ["s3:PutObject", "s3:DeleteObject"],
  "Resource": "arn:aws:s3:::photoshare-wuerfel/albums/norway-2026/*",
  "Condition": {"DateLessThan": {"aws:CurrentTime": "2026-08-26T00:00:00Z"}}
}
```

This fits how trip albums are actually used: everyone uploads within a couple of
weeks, then the album becomes something you look at for years. So `create`
defaults to **`--expires 30d`**. After that the gallery keeps working exactly as
before, and uploads simply stop being authorised — server-side, by Wasabi, with
nothing running on your machine.

The abuse window is therefore bounded by construction rather than by how quickly
you notice. Someone who finds the link in November cannot upload anything at all.

```console
$ ./tools/photoshare.py extend norway-2026 30d   # link keeps working
$ ./tools/photoshare.py list
SLUG          TITLE        PHOTOS  SIZE     UPLOADS
norway-2026   Norway 2026  842     6.2 GB   until 2026-08-26
alps-2025     Alps 2025    1203    9.1 GB   read-only
```

`extend` rewrites the policy only — the access key is untouched, so nobody needs
a new link.

#### Verified, not assumed

**Wasabi documents neither its supported nor its unsupported policy condition
keys** — its own [bucket policy page][wasabi-policy] shows only `IpAddress`
examples. So this was measured rather than inferred:

```console
$ ./tools/photoshare.py selftest
time condition (DateLessThan on aws:CurrentTime)
  control: read own album                  allowed
    test: write after expiry               denied

prefix condition (StringLike on s3:prefix) and resource fence
  control: list own album                  allowed
    test: list whole bucket                denied
    test: read another album               denied

  PASS  Album key cannot reach another album's objects
  PASS  Album key cannot enumerate other albums
  PASS  Upload expiry (--expires) is enforced
```

Each test provisions a **fresh** throwaway user — never an updated policy, since
policy updates can be served stale and silently turn a real denial into an
apparent allow. Every denial is only believed after that same key has
demonstrably succeeded at something else, and must hold for a settle window
(`--settle`, default 30s) rather than a single attempt.

> An earlier version of this test reused one user and mutated its policy between
> cases. It reported a false FAIL on the time condition — the expired write was
> being evaluated against the previous, still-cached permissive policy. If you
> ever see a lone FAIL here, suspect propagation before suspecting Wasabi.

**If `selftest` ever fails**, `--expires` is not a control on this account and
the fallback is detection:

```console
$ ./tools/photoshare.py check --revoke
ALBUM                          BILLABLE     QUOTA  STATUS
norway-2026                      6.2 GB     50 GB  ok
```

Exits 2 when over, so cron mails you; `--revoke` kills offending links without
touching data. Here the **cron interval is what bounds the worst case** — hourly
caps a gigabit attacker at roughly €10 of committed spend. It's the weaker
control, which is why it's the fallback rather than the plan.

**As things stand you do not need it.** The expiry is enforced, so the upload
window closes itself. Keep `check` as an occasional manual sanity command
(`./photoshare.py check`) rather than a cron job.

`check` counts non-current versions, since versioning means deleted bytes keep
costing money. That's deliberately a different number from what `list` shows.

Finally, weigh the threat model: the link lives in a group chat among people you
went on holiday with. The realistic failure is a leaked link found by someone
bored, not a determined adversary — and with a 30-day window, most leaks happen
after uploads are already closed. If that ever changes, `revoke` is instant and
free.

---

## 3. Cost model (Wasabi specifics that affect the design)

Three Wasabi billing rules shape how the CLI behaves:

**1 TB monthly minimum (~$7/mo).** You already pay this. Below 1 TB, storage is
effectively free — an 8 GB trip album costs you nothing incremental. Don't
optimize storage.

**90-day minimum storage duration.** Deleting an object before 90 days still
bills you for the remaining days ("Timed Deleted Storage"). Combined with the
1 TB minimum, this makes early deletion actively pointless: you pay either way.

> **Design consequence:** `revoke` (delete the IAM user) is the default
> operation, and `rm` (delete the objects) is the rare one. Revoking is free,
> instant, and reversible; deleting costs money and destroys data. The CLI is
> built around this asymmetry and warns before `rm`.

**Free egress, with a fair-use ratio.** Wasabi's free egress
[expects monthly downloads not to exceed stored data][wasabi-egress]; sustained
2–3× overage may lead to throttling or a request to change plans.

The ratio is **account-wide**, not per-bucket, and the ~500 GB of backups
already in this account count toward the "stored" side. That gives roughly
500 GB/month of egress headroom before the policy is even in question — far
more than a trip album will ever consume. **This is a non-issue at your scale.**

Taken in isolation the workload does have the wrong shape (an 8 GB album pulled
in full by 10 friends is 80 GB against 8 GB stored, a 10:1 ratio), so the
mitigations below are still worth having — they're cheap, and they're what keeps
it a non-issue if the app ever outgrows one account:

- **Never browse on originals.** The grid serves `thumbs/` (~85 KB) and the
  lightbox `mid/` (~300 KB) against a 4 MB original, so nothing but an explicit
  download pulls the real file. This is why §7.1 writes both derivatives at
  upload rather than serving full images scaled down — a cost decision as much
  as a performance one.
- **Download only what's new.** The per-user sync state (§8.4) means the second
  visit transfers only the delta.
- **Don't delete old albums.** Keeping them raises your stored volume, which
  *improves* the ratio — and it's free under the 1 TB minimum. Another reason
  `revoke` beats `rm`.

With 500 GB already stored, none of this is load-bearing for you today. It would
only start to matter if the albums became the dominant thing in the account.

---

## 4. Setup

### 4.0 IAM in sixty seconds

Four concepts, and the whole setup follows from them:

| Thing | What it is |
|---|---|
| **User** | An identity. On its own it can do **nothing** — IAM is default-deny. |
| **Policy** | A JSON document listing allowed actions on resources. Inert on its own; it's just a document. |
| **Attaching** | Connecting a policy to a user. *This* is what grants permission. |
| **Access key** | An id + secret that lets a program authenticate *as* a user. It inherits exactly that user's permissions — no more. |

So a working credential is always: create user → create policy → attach → make
key. Skip the attach and you have a key that is authenticated but authorised for
nothing, which produces `AccessDenied` on everything.

Policies come in two flavours, and this project uses both:

- **Managed** (standalone, named, reusable across users) — created under
  *Policies* in the console. The admin policy is one of these, because you
  attach it by hand.
- **Inline** (embedded in a single user, unnamed) — what `PutUserPolicy`
  writes. Every album user gets one of these, because it's generated per album
  and dies with the user.

> **The `path` field is a red herring.** IAM users have an optional *path* like
> `/engineering/` — it is a purely organisational label for grouping users, and
> it has **no effect whatsoever on what a user can access**. It is not related
> to bucket names or object prefixes. Leave it empty. All access comes from the
> policy, never from the path.

### 4.1 One time, in order

No root access key is needed. The CLI runs as a dedicated **admin sub-user**
fenced to one bucket and to IAM users named `ps-*`.

1. **Create the bucket by hand** in the Wasabi console: name
   `photoshare-wuerfel` (globally unique across all Wasabi customers), region
   **`eu-central-2`** (Frankfurt). Versioning optional — see the note below.

2. **Write `~/.config/photoshare.toml`**:

   ```toml
   bucket    = "photoshare-wuerfel"
   region    = "eu-central-2"         # Frankfurt
   site      = "https://photos.wuerfel.io/"
   op_key    = "op://Private/Wasabi/access key id"
   op_secret = "op://Private/Wasabi/secret access key"
   ```

3. **Create the policy first** (it must exist before you can attach it).
   Console → **Policies** → *Create Policy*, name it `photoshare-admin-policy`,
   and paste the output of:

   ```console
   $ ./tools/photoshare.py admin-policy > /tmp/policy.json
   ```

   If Wasabi rejects the wildcard account in the IAM ARN, re-run with
   `--account <your-account-id>` (console → Settings).

4. **Create the user.** Console → **Users** → *Create User*:
   - Username `photoshare-admin`
   - Type of access: **Programmatic** (API key). Console access is not needed.
   - Leave **path** empty — it does nothing (§4.0).
   - At the policy step, attach `photoshare-admin-policy`.

   Copy the access key id and secret at the end — **the secret is shown once**.

5. **1Password**: store that key as an item with fields `access key id` and
   `secret access key`, and point `op_key`/`op_secret` at it. One item; the
   bucket name lives in the config, not in 1Password.

6. **`chmod +x tools/photoshare.py && ./tools/photoshare.py init`** — verifies
   IAM access, verifies the bucket is reachable, optionally enables versioning,
   and does an end-to-end write probe. Safe to re-run. There is no CORS step.

7. **`./tools/photoshare.py selftest`** — confirms Wasabi really enforces the
   upload expiry (§2.3). Run this once, before the first real album.

`init` creates the bucket only if it's missing, so making it by hand in step 1 is
fine — it just verifies and reports. If a permission is missing it names it.

> **On skipping versioning.** It's a defensible call here, more so than it looks:
> `DeleteObject` sits in the same expiring statement as `PutObject`, so with the
> default `--expires 30d` a link holder can only delete during those 30 days
> too. What you give up is any undo for a delete inside that window — including
> your own `rm`. Run `init --no-versioning` to keep it off; the CLI works either
> way (`check` and `rm` handle unversioned buckets correctly).

The config file holds 1Password *references*, not secrets, so it's safe at rest.
Keep it out of the repo anyway.

#### Why this beats a root key — and the one honest caveat

Wasabi [supports `iam:` actions in sub-user policies][wasabi-delegate], so the
admin policy carries two fences: `s3:*` on the photoshare bucket only, and IAM
actions restricted to `arn:aws:iam::*:user/ps-*`. Concretely, a stolen laptop
gets a key that **cannot touch your 500 GB of backups**, cannot modify any
pre-existing user, and can be revoked in one console click without disturbing
anything else. A root key has none of those properties and can also reach
billing and account deletion.

The caveat, stated plainly: any principal that can call `CreateUser` +
`PutUserPolicy` can in principle escalate — create a `ps-`-prefixed user and
attach a broader policy to it. AWS fences this with permissions boundaries;
Wasabi has no equivalent, so the escalation path is real.

That doesn't make the exercise pointless. It raises the attack from "use the key"
to "notice the escalation path and take deliberate extra steps", and it removes
the *accidental* blast radius entirely — a buggy script or a fat-fingered command
genuinely cannot reach your backups. Worth doing; just don't file it as a hard
security boundary.

`iam:ListUsers` is granted on `*` because list operations can't be
resource-scoped in IAM. It's read-only and exposes only user names.

### 4.2 GitHub Pages on `photos.wuerfel.io`

1. Add a file named `CNAME` at the repo root containing `photos.wuerfel.io`.
2. DNS: `CNAME photos → <youruser>.github.io`.
3. Repo Settings → Pages → set the custom domain, then tick **Enforce HTTPS**.
   Wait for the certificate before testing — the app needs HTTPS for
   `crypto.subtle`, service workers, and `navigator.share`.

Because the site sits at the root of its own subdomain, all app paths are
`/...` rather than `/photoshare/...` — relevant for the service worker scope and
the share-target action in §8.2.

### 4.3 Per trip

```console
$ ./tools/photoshare.py create "Norway 2026"
created album 'norway-2026' (Norway 2026)

  upload+view link:
  https://photos.wuerfel.io/#norway-2026.WQ4T1XJ8HZ2M9K3PR6VB.uY7k...

  The secret is in the link and is not stored anywhere else.
  Lost it? `photoshare.py link norway-2026` issues a new one.
```

Paste the link into the group chat. Done.

### 4.4 CLI reference

| Command | Effect | Cost |
|---|---|---|
| `admin-policy` | Print the IAM policy for the CLI's own sub-user | — |
| `init` | Verify access, create bucket if missing, enable versioning | — |
| `list` | All albums: photo count, size, whether the link is live | — |
| `selftest` | Verify Wasabi enforces upload expiry. Run once (§2.3) | free |
| `create "Title"` | Prefix + `album.json` + IAM user + key → prints link | free |
| `create --expires 30d` | Upload window (default 30d; `never` to disable) | free |
| `create --readonly-link` | Additionally mint a view-only link | free |
| `create --save` | Also store the link in 1Password | free |
| `create --long` | Emit the old self-contained link form (§5.2) | free |
| `extend <slug> 30d` | Move the upload deadline; **link keeps working** | free |
| `link <slug>` | Re-issue (rotates key, **kills the old link**) | free |
| `revoke <slug>` | Delete IAM users → all links dead, photos kept | free, reversible |
| `rm <slug>` | Delete every object *version*, then revoke | 💸 90-day charge |
| `check [--revoke]` | Quota watchdog; exit 2 if over. For cron (§2.3) | — |
| `info <slug>` | Stats + upload counts per person | — |

Optional quota keys in the config (defaults 50 / 400):

```toml
album_quota_gb = 50
total_quota_gb = 400
```

No crontab entry is needed: `selftest` passed, so the expiring upload window
already bounds the risk with nothing running. `check` stays useful as an
occasional manual look. Only if a future `selftest` regresses would you want:

```cron
17 * * * * /home/hw/dev/photoshare/tools/photoshare.py check --revoke
```

Two design notes:

**No local state.** Albums are discovered by listing `albums/` prefixes in the
bucket and cross-referencing IAM users. The bucket is the source of truth, so
the CLI works from any machine that can reach 1Password.

**Secrets are never stored.** `create` prints the link once. Wasabi returns a
secret key exactly once, and the CLI deliberately doesn't persist it. If you
lose a link, you don't recover it — you rotate it with `link`, which is a
one-second operation.

---

## 5. Architecture

```
┌─────────────────────┐        ┌───────────────────────────┐
│  GitHub Pages       │ loads  │  Friend's phone browser    │
│  (static HTML/JS)   │───────▶│  - identity in localStorage │
└─────────────────────┘        │  - creds from URL fragment  │
                               │  - SigV4 signing in JS      │
                               └─────────────┬───────────────┘
                                             │ HTTPS, CORS wide open
                                             │ GET / PUT / list-type=2
                                             ▼
                               ┌───────────────────────────┐
   ┌──────────────┐   IAM API  │  Wasabi bucket             │
   │ photoshare   │───────────▶│  albums/<slug>/...         │
   │ CLI + 1Pass  │   S3 API   │  ← single source of truth  │
   └──────────────┘            └───────────────────────────┘
```

No server of yours is involved after page load.

### 5.1 Layout

```
s3://photoshare-wuerfel/
  albums/
    norway-2026/
      album.json            { schemaVersion, slug, title, createdAt }
      photos/
        1753612800000-a3f9c1-8b21d4e09c37.jpg    the original bytes, untouched
        └─ uploadedAt ms ─┘ └uid┘ └content hash┘
      mid/
        1753612800000-a3f9c1-8b21d4e09c37.jpg    (~2048px JPEG, the lightbox)
      thumbs/
        1753612800000-a3f9c1-8b21d4e09c37.jpg    (~512px JPEG, the grid)
      users/
        a3f9c1.json         { uid, name, updatedAt,
                              photos: { <base>: { captured } } }
      state/
        a3f9c1.json         { uid, lastSeenAt, downloaded: [...] }
```

Two deliberate choices:

**The filename is the metadata.** Uploader, timestamp, and content hash are in
the name, so one `ListObjectsV2` call returns the complete album index — no
separate index file, and no way for metadata to drift out of sync with reality.
If every JSON file vanished, the gallery would still render correctly. It also
lets `photoshare info` report per-person upload counts without reading a single
object body.

**But only immutable identity goes in the filename.** Content hash, uploader and
arrival order are facts that must never drift and must be free to read, so they
belong in the key. *Derived* metadata does not: putting a capture date there
would make it permanently unfixable, because changing a key means copy + delete
at a 90-day storage charge. So `users/<uid>.json` carries a `photos` map, and
that's the general home for enrichment — capture dates now, captions later.

There are exactly **two** files per person rather than one or three, split on
who reads them and how often they change:

| | Written by | Read by | Rewritten | Grows with |
|---|---|---|---|---|
| `users/<uid>.json` | owner | **everyone**, at boot | on rename or upload | that person's uploads |
| `state/<uid>.json` | owner | **owner only** | every ~1.5 s while saving | album size |

Name and photo metadata share an audience and a lifecycle, so keeping them apart
would only have cost a second `list()` plus N GETs at boot for no benefit —
capture dates now arrive free with the names everyone already fetches. Seen state
stays out because merging it would make every visitor download everyone's
`downloaded` array just to label tiles, would re-upload your name and every
capture date on each save, and would put data other people depend on inside the
blast radius of the app's most frequent write. The two also want different error
policies: a read-only link legitimately can't write state and `seen.js` goes
quiet about it, whereas a failed name write is worth telling someone about.

**One writer per file.** This is the load-bearing concurrency decision. A shared
`index.json` would be a disaster: S3 has no transactions, so two friends
uploading at once would read-modify-write and silently clobber each other.
Instead `users/<uid>.json` and `state/<uid>.json` are only ever written by their
owner. Concurrent writers never touch the same key, so conflicts are
structurally impossible and no locking is needed.

Two refinements now that `users/` holds per-photo data. **Write once per upload
batch, never per photo** — `upload.js` runs three PUTs in parallel, and three
read-modify-writes of one key would clobber each other; that intra-device race is
far likelier than the two-device one. And **merge on write rather than
overwriting**: `writeUser` unions the remote `photos` map into the local one, so
the same person on a laptop and a phone doesn't lose dates. Capture dates are
append-only per key, so a union is simply correct; the name is last-write-wins,
which is what you want anyway. `seen.js` already does the same for `downloaded`.

The content hash (first **12** hex of SHA-256 via `crypto.subtle`) gives free
deduplication: re-uploading the same photo produces the same key and overwrites
rather than duplicating. This matters more than it sounds — people re-pick the
same photos constantly.

> **Why 12 and not 8.** Truncation length is load-bearing here precisely because
> dedup is implicit: a collision between two *different* photos silently
> overwrites one of them, with nothing anywhere to notice it happened. 8 hex is
> 32 bits, which by the birthday bound is roughly 1-in-8,600 across a
> thousand-photo album — too likely for a failure this quiet. 48 bits puts it
> past 1-in-500,000. Widening needed no parser change (`NAME` already accepted
> 6–32 hex) but it does mean old and new uploads don't dedup against each other,
> so it was done during the debug phase deliberately.

> **Verified on iOS, 2026-07-27.** The same camera photo picked three times in
> separate picker sessions produced one object, not three — so Safari's
> HEIC→JPEG transcode is byte-for-byte deterministic and the hash is stable
> across picks. This was the load-bearing assumption; without it dedup would
> have had to fall back to EXIF `DateTimeOriginal` + dimensions.
>
> The one case that does **not** dedup: an image saved out of the share sheet
> and re-picked. iOS re-encodes on save, so the library item is genuinely a
> different file. Correct behaviour, but worth knowing before someone reports it
> as a bug.

### 5.2 The album link

```
https://photos.wuerfel.io/#<slug>.<keyid>.<secret>[.r]        100 chars
```

Of those 100, **60 are the credential** — a 20-character access key id and a
40-character secret — and that part is irreducible. Everything else the app
reconstructs:

| Dropped | Recovered from |
|---|---|
| `ep` | `https://s3.{region}.wasabisys.com` |
| `rg`, `b` | constants in `js/album.js`, mirrored in the CLI (see below) |
| `p` | `albums/<slug>/` |
| `n` | `album.json`, read on connect — so the title survives a rename |
| `v`, `t` | positional: three dot-separated fields *is* the format |

There is deliberately **no base64 here**. The secret is the only field that can
contain URL-hostile characters (Wasabi secrets routinely have `/` and `+`), and
mapping those two to `-` and `_` costs nothing, where encoding the whole
payload would add a third on top of it. A trailing `.r` marks a view-only link.

**The long form is still live**, and not only for old links:

```
https://photos.wuerfel.io/#a=<base64url(JSON)>                ~330 chars
```

```json
{
  "v": 1, "t": "s3",
  "ep": "https://s3.eu-central-2.wasabisys.com",
  "rg": "eu-central-2",
  "b":  "photoshare-wuerfel",
  "p":  "albums/norway-2026/",
  "k":  "ACCESSKEY", "s": "secret",
  "n":  "Norway 2026",
  "ro": 1
}
```

It carries the bucket and region explicitly, so it is what `make_link` emits
whenever the compact form would be wrong or unparseable — a config naming a
different bucket, a hand-passed `--slug` with a space in it, a secret outside
the expected charset — as well as on `--long`. **The fallback is automatic**,
which is the point: the compact form is an optimisation, and it is not allowed
to be the reason a link fails at the far end of a group chat. `js/album.js`
accepts both and always will; the long decoder is permanent, not a migration.

The one real cost is that `SITE_BUCKET`/`SITE_REGION` in `tools/photoshare.py`
and `SITE` in `js/album.js` must agree. They are commented as mirrors of each
other, and a *config* pointing elsewhere degrades safely to the long form — the
only way to get a wrong link is to edit one constant and not the other.

`ro` lets the app hide the upload and delete controls up front rather than
letting people discover the restriction by hitting a 403. The IAM policy is
still what enforces it — the flag only saves a wasted tap, so a link with a
forged `ro: 0` gains nothing.

In the long form, decode through `TextDecoder` rather than trusting `atob`'s
byte-per-char output, so album titles with umlauts survive:

```js
const decodeAlbum = (s) => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - b64.length % 4) % 4));
  return JSON.parse(new TextDecoder().decode(
    Uint8Array.from(bin, (c) => c.charCodeAt(0))));
};
```

The compact form sidesteps that problem rather than solving it: no non-ASCII
ever rides in the link, because the title no longer does.

---

## 6. Backend adapter interface

Keep this small and boring, so a second backend stays possible:

```js
// Entry: { path, name, size, mtime, etag }
//
// interface Backend {
//   list(dir)        -> Promise<Entry[]>
//   get(path)        -> Promise<Blob>
//   put(path, blob)  -> Promise<void>
//   remove(path)     -> Promise<void>
//   urlFor(path)     -> Promise<string>   // presigned, for <img src>
// }
```

`urlFor` is async here (it was sync in the Nextcloud draft) because S3 objects
are private and the URL must be signed. Worth it: a presigned URL drops straight
into `<img src>`, so the browser handles fetching, caching, and progressive
decode natively instead of you shuttling blobs through JS.

### 6.1 S3 adapter

Signing SigV4 by hand is unpleasant; [`aws4fetch`] does it in ~5 KB and works in
browsers. Vendor it into `lib/` rather than depending on a CDN.

```js
import { AwsClient } from './lib/aws4fetch.js';

export function s3Backend({ ep, rg, b, p, k, s }) {
  const aws = new AwsClient({
    accessKeyId: k, secretAccessKey: s, region: rg, service: 's3',
  });
  const key = (path) => `${p}${path}`;

  async function list(dir) {
    const out = [];
    let token;
    do {
      const u = new URL(`${ep}/${b}`);
      u.searchParams.set('list-type', '2');
      u.searchParams.set('prefix', key(dir));   // required by the IAM policy
      if (token) u.searchParams.set('continuation-token', token);

      const res = await aws.fetch(u);
      if (!res.ok) throw new Error(`list ${dir}: ${res.status}`);
      const xml = new DOMParser().parseFromString(await res.text(), 'text/xml');

      // S3 XML is namespaced; the *NS variants avoid prefix surprises.
      const tag = (el, n) => el.getElementsByTagNameNS('*', n)[0]?.textContent;
      for (const c of xml.getElementsByTagNameNS('*', 'Contents')) {
        const full = tag(c, 'Key');
        out.push({
          path: full.slice(p.length),
          name: full.split('/').pop(),
          size: +tag(c, 'Size'),
          mtime: Date.parse(tag(c, 'LastModified')),
          etag: tag(c, 'ETag')?.replace(/"/g, ''),
        });
      }
      token = xml.getElementsByTagNameNS('*', 'NextContinuationToken')[0]?.textContent;
    } while (token);          // >1000 objects is normal for a trip album
    return out.filter((e) => e.name);
  }

  const put = (path, blob) =>
    aws.fetch(`${ep}/${b}/${key(path)}`, { method: 'PUT', body: blob })
       .then((r) => { if (!r.ok) throw new Error(`put ${path}: ${r.status}`); });

  const get = (path) =>
    aws.fetch(`${ep}/${b}/${key(path)}`)
       .then((r) => r.ok ? r.blob() : Promise.reject(new Error(r.status)));

  const remove = (path) =>
    aws.fetch(`${ep}/${b}/${key(path)}`, { method: 'DELETE' });

  async function urlFor(path) {
    const signed = await aws.sign(
      `${ep}/${b}/${key(path)}?X-Amz-Expires=86400`,
      { method: 'GET', aws: { signQuery: true } },
    );
    return signed.url;
  }

  return { list, get, put, remove, urlFor };
}
```

Note the pagination loop — `ListObjectsV2` caps at 1000 keys, and a trip album
with photos + thumbs crosses that quickly. Getting this wrong produces an album
that silently truncates, which is a miserable bug to notice.

---

## 7. Feature design

### 7.1 Upload

**The picker is genuinely native** — the part you were unsure about is the
easiest thing here:

```html
<input type="file" accept="image/*" multiple>
```

iOS opens the real Photos picker sheet; Android the system photo picker.
Multi-select works on both, and you get real `File` objects.

`accept` is images only, on purpose — adding `video/*` here is one character and
everything downstream of it is not (§11.2).

Do **not** add `capture` — it forces the camera and removes the library option.

**Dropped files are the same door.** On anything with a real pointer, dragging
files onto the page is the shortcut for `+`, and it ends in the same `run()`:
dedup, derivatives, the task sheet and the retry button are the ones that were
already there, so there is no second upload path to keep in step. Four things
the drop side has to do that the picker gets for free:

- **`preventDefault()` on `dragover`, always** — without it no `drop` event ever
  fires, *and* the browser leaves the album to display the dropped file.
- **Filter by hand.** `accept="image/*"` has no drop equivalent. An empty `type`
  is ordinary (Windows hands over HEIC with no MIME), so the extension is the
  fallback rather than grounds for refusal, and anything skipped is said out
  loud in a toast rather than silently dropped.
- **Walk folders.** Dragging a folder of photos out of a file manager is the
  obvious gesture, and `dataTransfer.files` answers it with the folder itself —
  a zero-byte entry that would upload as garbage. `webkitGetAsEntry()` tells the
  two apart, but it must be called *before* the handler yields, so the entries
  are collected synchronously and read afterwards. `readEntries` returns at most
  100 at a time; it has to be called until it comes back empty.
- **Know when to say no.** Read-only links take the drop only to explain
  themselves, and a drop landing mid-upload is refused with a toast, because a
  second `run()` would rewrite the first one's rows out from under it.

The overlay is `pointer-events: none` — the listeners are on `window`, so it
only has to be seen. It hides on a 900 ms fuse that each `dragover` renews: the
DnD model re-fires `dragover` every 350 ms even on a stationary pointer, and a
*cancelled* drag (Escape, a drop on another window) reports nothing at all.

Because the gesture is invisible, it's named in the legend and in the
empty-album line, on a `(pointer: fine)` test in both places.

Per file:

1. **Hash** the bytes → content id → skip if that key already exists.
2. **Decode** via `createImageBitmap(file, { imageOrientation: 'from-image' })`.
   Pass the option explicitly: the spec's default moved to `from-image`, but
   older Safari and Chrome shipped `none`, which leaves a rotated photo's
   derivatives sideways under an upright full-size view. iOS usually transcodes
   HEIC→JPEG on pick, but not always; if this throws, upload the original with
   no derivatives rather than failing the upload.
3. **Thumbnail**: `OffscreenCanvas` at max 512px, `toBlob('image/jpeg', 0.7)`.
   Directly load-bearing for the egress ratio (§3).

   > **Measured, not estimated:** real iPhone photos yield **~85 KB** at
   > 384×512 q0.7 — roughly double the 40 KB this section originally assumed.
   > Detailed photographs compress far worse than synthetic test images. If
   > gallery load matters, 384px at q0.6 gets closer to 40 KB; at ~1000 photos
   > that's 85 MB vs 40 MB per full browse.
4. **Mid copy**: max 2048px at q0.82, for the lightbox (§7.6). Skipped when the
   original's long edge is already under the cap — re-encoding it would cost
   quality and save nothing, which is why `mid/` is allowed to be missing.
5. `put()` thumbnail, mid, then the original.

**The original is uploaded byte-for-byte. There is no downscale toggle.** An
earlier version had one (4000px cap, default off) and it was removed: the entire
premise of the app is that your friends get the real file rather than what a
messenger app left of it, so an option to silently defeat that is a liability
rather than a feature. Dropping it also deleted the only code path that
re-encoded an original, which is what makes the EXIF story below a one-liner.

**EXIF therefore survives intact** — capture date, camera, orientation, and
**GPS**, all of it on purpose. Canvas re-encoding used to strip EXIF as a side
effect of the downscale path; nothing does now, and nothing should. Location is
part of what makes a trip photo worth keeping, and the alternative isn't cheap
anyway: stripping GPS *specifically* means rewriting the EXIF block rather than
discarding it, since discarding takes `DateTimeOriginal` with it. The trade is
recorded in §2 — anyone holding the link can read where a photo was taken.

Note the app still doesn't *read* EXIF: dates come from the upload timestamp in
the filename, not `DateTimeOriginal`. A photo shot last summer and uploaded
today sorts as today. Phase 4.

**Concurrency 2–3, not 20.** Phones on hotel wifi with 20 parallel PUTs will
stall. Use a small worker pool with backoff on 5xx.

Show a per-file progress list — uploads of 200 photos *will* fail partway, and
the UI must make it obvious what succeeded and let you retry the rest. (`fetch`
has no upload progress events; if you want real per-file progress bars rather
than done/not-done, that one request needs `XMLHttpRequest`. It's the one place
the old API is still better — though it complicates SigV4 signing, so consider
whether done/not-done is enough.)

### 7.2 Gallery

CSS grid of thumbnails via presigned `urlFor()` URLs, newest first. Tiles are
built once and filtering toggles `hidden` — no re-render, and it stays smooth at
a thousand photos.

**Sort is switchable between "added" and "taken"** (`photoshare.sort`, the one
thing allowed to live in `localStorage` alone, since losing a view preference
costs nothing). Added uses the timestamp in the filename; taken uses the EXIF
date from `users/<uid>.json`, falling back to upload time for photos that don't
claim one. The control is hidden entirely when no photo in the album has a
capture date, rather than offering something that reorders nothing.

It's a two-cell **segment** — both modes on screen, the active one lit in the
safelight — and not a relabelling button. Sort is a mode rather than an action,
so the control should state the current order without being tapped; and the
first version borrowed `.metabtn` from Select, whose `::before` square made it
read as a second checkbox sitting next to the real one.

**A three-line legend sits above the grid on every visit.** The app's two least
obvious ideas are that `↓ Save 12` means *the twelve you don't have yet* —
`pending()` already subtracts what `seen` knows you saved and everything you
uploaded — and that the whole point is camera roll to camera roll rather than
files handled by hand in between. Neither survives being inferred from a number
in the dock.

It is a legend and not an introduction, and the distinction is the only reason
it gets read: every row is keyed by a glyph visible on the same screen (`+`,
`↓ Save`, `Select`), so it parses as a caption for what's already there instead
of documentation to be skipped. Three rows is the budget. It follows the same
branches the controls do — no `+` row on a read-only link, and the headline
promises the camera roll only where `canSaveToGallery()` is true — because a
legend that names a control the reader can't see is worse than none. An empty
album is left to `galEmpty` instead.

**The ✕ lasts for the visit, not forever** (`introHidden`, a plain module
variable, deliberately not stored). The two dismissal models cost different
things. Remembering it permanently buys back ~90px once and then owes the
reader a way to undo it — and the only honest place for that control, the
header beside Select, would cost every visit more than the card does. Forgetting
it costs a few hundred pixels on each load and nothing else, because the card is
cheap to re-read and a reload is a recovery path everyone already has. So the
✕ means "not now", the state it clears is the one people actually want cleared
— *this screen is in my way* — and there is no third control to explain.

**`↓ Save 0` greys out; it does not leave the dock.** Once the legend is
permanent this stops being cosmetic: having nothing left to save is the steady
state for anyone returning to an album they've been through, and it's permanent
in an album where you're the only uploader, since `pending()` subtracts your own
photos too. A row captioning a button that isn't there — or was never there —
is the failure the glyph-keying was supposed to prevent. Keeping the button
disabled fixes that and is better on its own terms: the dock stops reflowing
every time you save, filter or upload, and a greyed zero answers "how many do I
still need?" where an absent button leaves you to guess. The label stays
`↓ Save <n>` at zero rather than switching to *All saved*, which would be a lie
in the only-uploader case. It still hides entirely while selecting (the dock
belongs to the selection actions) and on a genuinely empty album.

Re-sorting reuses the build-once trick: appending an already-attached node
*moves* it, so reordering the whole grid is one `append` call and every loaded
thumbnail, presigned URL and selection survives it.

**Frame numbers deliberately don't follow the sort.** They're an identity — shown
in the lightbox, baked into download filenames — and they stay in arrival order,
so sorting by capture date puts 007 next to 042. That reads as "shot together,
uploaded weeks apart", which is information. For the same reason the "new" badge
and `lastSeenAt` stay on upload time: new means *new to the album*, not recently
shot.

Presigning is **lazy**, driven by an `IntersectionObserver` with a 400 px
margin. Signing every thumbnail up front would be a thousand HMAC chains before
the first paint.

**Attribution is carried by colour.** Each person gets a hue that appears on the
rule under their frames, in their frame numbers, on their filter chip and next
to their name — so who-shot-what is a glance rather than a label to read.
Colours come from 24 hues, and the palette is assigned across the album's
actual members to spread them as far apart as possible: four friends land ~80°
apart, and nobody is ever placed within 27° of someone else — near-identical is
worse than identical, because you think you can tell them apart and can't.
Members are ordered by first upload, which makes assignment append-only, so
somebody joining on day five never recolours anyone already there. Past the
point where 27° can be maintained, hues repeat at a darker lightness.

The tile also carries the uploader's **first name** under the frame number.
Full names go in the chips and the lightbox; at 92 px a full name is all
ellipsis and no information.

**Marks appear only where there's something to act on** — new and saved get a
grease-pencil ring, the ordinary middle state stays clean. Saved beats new,
since it's the terminal state. The saved mark is reversible: *Unmark* in the
lightbox, or on a selection, puts a photo back in the download queue.

Tap opens the lightbox. Long-press, or the *Select* control in the header,
enters **selection mode**: tap tiles to pick, then *Save* / *Unmark* / *Delete*
the lot. *Select all* takes everything in the current view, so filtering to one
person and selecting all means that person's photos. Tapping the empty sheet
around the photos leaves selection mode.

Three things have to be suppressed on a thumbnail for long-press to mean
"select", and missing any one of them breaks it in a different way:

| | Without it |
|---|---|
| `-webkit-touch-callout: none` | the OS context menu opens instead |
| `user-select: none` | the press starts a text selection |
| `draggable="false"` + `-webkit-user-drag: none` | the browser starts a native image drag |

The last one is the subtle one, and it was a real bug: dragging lifts the
`<img>` into its own compositing layer **above** the tile's own chrome, so the
selection ring and highlighted border vanish underneath the image being
dragged. It looks like the selection failed when in fact it worked. A
`dragstart` handler calling `preventDefault()` backs up the CSS.

The lightbox is deliberately the opposite — its images keep the callout, since
long-press → *Add to Photos* is the fallback when Web Share is missing (§7.5).

**Delete applies to anyone's photo**, not just your own. The first build fenced
it to your own uploads, but that fence protected nothing — everyone holding the
link has `s3:DeleteObject` on the whole prefix regardless (§2), and among
friends the realistic need is clearing someone's forty blurry shots after they
have lost their identity. What guards it now is the confirmation, which names
the uploader and says the deletion is permanent and silent. Honest friction
beats a lock with no door.

### 7.3 Identity

First visit lands on the identity screen, before the gallery: a name field
prefilled with a random friendly name ("Wandering Elk") over a 6-hex `uid`,
stored as `{uid, name}` in `localStorage` and written to `users/<uid>.json`.

Identity is **global, not per-album** — you're the same person on every trip.

Underneath the name field sits **"or continue as"**: every user found in
`users/`, each in their own colour, one tap to adopt. That list is not a
nicety, it's the recovery path for §8.1, so it gets real estate on the first
screen rather than a settings submenu. It also makes testing with several
identities trivial.

The header's identity chip reopens the same screen, which is where **rename**
lives too — it rewrites that one file, and since names resolve at render time
every existing photo relabels instantly.

### 7.4 Sync state

`state/<uid>.json` = `{ uid, lastSeenAt, downloaded: [contentHash, ...] }`,
written only by its owner (§5.1) so it's conflict-free. Mirror into
`localStorage` for instant startup, then reconcile with the remote copy by
**unioning** the `downloaded` arrays rather than picking a winner — so using
both a phone and a laptop never loses state.

This gives "New since your last visit (12)", a "Download all new" button, and
correct behaviour across devices. Advance `lastSeenAt` only when the user
actually views the gallery, not on every page load, or the badge becomes
meaningless.

### 7.5 Download / save to gallery

The dividing line is **not iOS versus Android — it's whether the browser
implements Web Share for files.** That turned out to matter more than the
platform split this section originally assumed.

**iOS/Safari — works. Verified 2026-07-27.** This was the biggest open risk in
the design, because file sharing has historically been flaky on iOS: it worked
in 15.7, [regressed in iOS 16][ios16] to offer only "Save to Files", and shifted
across releases after that. Measured on a real iPhone, the share sheet **did**
offer *Save Photo*, for a single file and for a 3-file batch, and the images
landed in the photo library.

**Android/Chrome — works well.** `navigator.share({ files })` opens the system
sheet with a real "Save to Photos" target, multiple files per call. Samsung
Internet and Edge are Chromium too, so they behave the same.

**Android, everything else — mostly no file sharing.** Found the hard way on a
Fairphone running DuckDuckGo, 2026-07-27: bulk save produced *one* file, in
Downloads, named after a blob UUID.

Confirmed against the compatibility data rather than assumed:

| Runtime | `navigator.share` | Files (Level 2) |
|---|---|---|
| Chrome, Brave, Edge, Samsung Internet (Android) | ✅ 61+ | ✅ |
| Safari (iOS) | ✅ 12.2+ | ✅ 14+ |
| iOS WKWebView | ✅ | ✅ |
| **Android WebView** | ❌ **absent entirely** | ❌ |
| **Firefox for Android** | ✅ 79+ | ❌ **no file support** |
| Windows WebView2 | ❌ | ❌ |

Two things in that table drive the design.

**Android WebView has no Web Share at all** — not Level 2, not even Level 1
([caniwebview][caniwebview], data current to 2026-07-25, which lists
`api.Navigator.share` and its `files` and `text` parameters all as unsupported).
And DuckDuckGo's Android browser is [WebView-based by design][ddg-webview]: it
deliberately uses the OS rendering engine instead of bundling Chromium. So this
is a property of the browser, not of the Fairphone or of any setting.

**Firefox for Android is the trap.** It *has* `navigator.share` (79+), so a
naive `if (navigator.share)` check passes — but it [cannot share files][ffshare].
Probing with `canShare({ files: [probeFile] })` is what catches it; probing
`navigator.share` alone would produce a confident failure at the worst moment.

**Capability is necessary but not sufficient: desktop Chrome is the other trap,
in the opposite direction.** Found on Windows, 2026-07-28. It answers *yes* to
`canShare({ files })` and really does share — but the Windows sheet it opens
offers Mail and Teams, not "save into this folder", which is not what anyone at a
keyboard means by saving a photo. It also rejects with `NotAllowedError`
intermittently, succeeding on a second attempt, which reads as a broken app.

So the branch is `canSaveToGallery()` — file-sharing capability **and** a coarse
primary pointer — rather than capability alone. The pointer query is not
user-agent sniffing: it asks whether this is the kind of device whose share sheet
has a *Save to Photos* target at all. A touch-screen laptop reports a fine
primary pointer and correctly lands on downloads, which is the better experience
there anyway: `downloadUrlFor` is one tap, moves no bytes through JS, and cannot
fail this way.

Falling through to the download path then breaks twice more:

- `<a download>` is ignored, so the filename comes from the `blob:` URL — hence
  the UUID.
- Only the first download in a gesture survives; the rest are dropped silently.
  Desktop Chrome asks "Download multiple files?" and then allows them, which is
  why this never showed up until a phone tried it.

The fix is in two parts. Filenames now come from the **server**: the download
URL is presigned with `response-content-disposition`, so Wasabi names the file
and no `blob:` URL is involved. aws4fetch signs every query parameter, so the
disposition is covered by the signature (verified locally). A side benefit is
that the bytes never pass through JS on this path at all — the browser
downloads straight from Wasabi.

And bulk download **steps one tap at a time on touch devices** (`isTouch()`,
i.e. `maxTouchPoints` or `pointer: coarse`) rather than firing a queue that
will be thrown away. Tedious for twenty photos, but every photo actually
arrives.

There is no code fix for the gallery half — a page cannot reach the photo
library without Web Share, and no permission or flag changes that. So the sheet
names the browsers that do work, and names Firefox as one that doesn't, since
"try another browser" otherwise sends people to the one alternative that fails
the same way. Photos landing in Downloads usually surface under a *Download*
album in the gallery app, which is worth saying out loud.

**It is an OS behaviour, not a contract.** iOS regressed once before and could
again. The fallback stays available: long-press the full-size image →
*Add to Photos*, which always works and is what people do reflexively. The
lightbox slides therefore keep `-webkit-touch-callout: default` — do not set it
to `none` to "clean up" the long-press menu. Grid thumbnails are the opposite
(`none`), because there a long-press means "start selecting".

### 7.6 Paging in the lightbox

Swiping is a **native scroll-snap carousel**: a flex track with
`scroll-snap-type: x mandatory`, one full-width slide per photo, and
`scroll-snap-stop: always` so a hard flick advances one photo rather than four.

The first version did the arithmetic by hand in a `touchend` listener, and it
was wrong in two ways at once — the image did not move with the finger, it just
cut to the next one, and the page won the axis fight, so a swipe scrolled
vertically before it panned. `touch-action: pan-x` on the track settles the
second point outright, and handing the gesture to the browser buys
finger-tracking, momentum and end-of-list rubber-banding for nothing.

**A slide never shows the original.** It paints the ~512px thumbnail first —
the grid just fetched it, so it is already in the browser's cache and costs no
request at all — and then swaps in the ~2048px `mid/` copy once that has
decoded off-screen, so the exchange doesn't flash. If `mid/` is missing (the
original was already small, or the uploader's browser couldn't decode it) the
tier below is the original, which makes that a normal fallback rather than an
error path.

Two things this fixed. Paging used to pull several MB per slide with ±2
preloaded, so opening the lightbox on hotel wifi meant a black screen for
seconds; and on a share-capable phone each slide fetched the original *twice* —
once query-signed into `<img src>`, once header-signed as a blob for the Save
button, two different URLs that the HTTP cache cannot reconcile. Browsing now
pays for a 2048px JPEG and only the Save path touches the original.

The `.lbslide img` box is sized `100% × 100dvh` with `object-fit: contain`
rather than shrink-to-fit, so the thumbnail and the mid copy land in identical
geometry and the photo doesn't jump under your thumb when they swap.

Slides exist for every photo but only carry an `src` within ±2 of the current
one, and anything past ±4 is unloaded again — a few dozen decodes is how you
crash mobile Safari (§8.3), and note that the pressure is the *decoded* frame,
~48 MB for a 12 MP photo however well it compressed. The current index comes from
`Math.round(scrollLeft / clientWidth)` on a settle-debounced scroll listener,
which is also what keeps the metadata bar and the prefetched save-blob in step.

**Nothing above the mid copy is ever fetched speculatively.** The Save button
used to download the original the moment you landed on a slide, so that the
bytes were in hand before the tap (see the gesture gotcha below) — which meant
swiping through fifty photos pulled fifty full-size originals for Save buttons
nobody pressed. It is now two taps: **Save** fetches, then **Save to Photos**
shares. The armed state goes `primary` because the button changed meaning and
that has to be unmissable.

The non-share path keeps its single tap, because there is nothing to prefetch —
`downloadUrlFor` only signs a URL, no bytes move until the click, and that click
has to be synchronous inside the tap or browsers block the download. So the URL
is still prepared up front there; it costs nothing.

This is also the shape a video needs (§11.2), which is most of why it's built
this way rather than with a size threshold.

**The gesture gotcha:** Safari requires `navigator.share()` to be called inside
a user-gesture task. `await fetch(...)` first and the gesture is gone
(`NotAllowedError`). Structure it as two taps:

```js
// Tap 1: "Prepare 12 photos" — fetch and cache the blobs.
const files = await Promise.all(ids.map(async (id) => {
  const blob = await backend.get(`photos/${id}`);
  return new File([blob], id, { type: blob.type });
}));

// Tap 2: a separate button, with no awaits before share().
shareBtn.onclick = () => {
  if (navigator.canShare?.({ files })) navigator.share({ files });
};
```

**Batch by bytes, not by file count.** Since every batch costs a tap, batching
small is a worse experience rather than a safer one — an earlier fixed batch of
10 meant ten manual taps to save a hundred photos, which is absurd for the
app's central action. The thing that actually constrains a `share()` call is how
many originals sit in memory while the sheet enumerates them, so `shareBatches`
fills each batch up to `BATCH_BYTES` (400 MB) with a loose count backstop.
Records carry their `size` from the bucket listing, so the split is known before
a single byte is fetched, and a typical hundred-photo album goes in one tap.

> **400 MB is a guess, and it's the first number to tune.** Phase 0 only ever
> verified a *3-file* share on hardware, so the ceiling on a large one is
> genuinely unknown. If bulk save misbehaves on a big selection, lower it; the
> failure mode to watch for is the tab dying rather than `share()` rejecting.

**Fetch each batch immediately before its own tap**, not the whole selection up
front. Fetching everything first held every original in memory before you could
save any of them, and made the first save wait on the last download. Per-batch
fetching is also what makes a video conceivable here at all (§11.2) — the byte
budget already generalises to one.

Branch on `canSaveToGallery()` (§7.5) — a real probe file through
`canShare({ files })`, plus a coarse primary pointer — never on user-agent
sniffing. Note that `canShare({ files: [] })` is not a reliable probe, since some
implementations return false for an empty array regardless of support.

**A resolved `share()` does not mean the file was saved.** The API deliberately
never reports which target the user picked, so "saved" is an optimistic mark, and
the lightbox's Unmark button is the escape hatch. What *is* guaranteed: a
rejection — `AbortError` on dismissal, `NotAllowedError` on a lost gesture —
marks nothing and leaves the fetched bytes in hand, so the same button can simply
be tapped again.

---

## 8. Platform caveats

### 8.1 iOS wipes `localStorage` after 7 days

Safari's ITP deletes script-writable storage for sites not interacted with in
7 days. For an album looked at twice a year, **assume identity will be lost.**

1. The **"I'm someone else" dropdown** (§7.3) makes this a 2-second annoyance
   rather than data loss. This is the real fix — it's why that dropdown is
   load-bearing.
2. **Installing the PWA** exempts it from the purge. Worth a gentle prompt.
3. Only `{uid, name}` is ever lost; everything else re-syncs from `state/`.
   Keep it that way — never let `localStorage` be the sole home for anything.

Use `localStorage`, not cookies: cookies are sent on every request (pointless
here), size-limited, and subject to stricter ITP rules.

### 8.2 PWA and Android share-target

A `manifest.json` + service worker gets you home-screen install, offline
thumbnail caching, and — Android only — **Web Share Target**: your album appears
in the system share sheet, so Google Photos → Share → Photoshare uploads
directly. Better than the in-app flow, for one manifest entry:

```json
"share_target": {
  "action": "/photoshare/share-target/",
  "method": "POST",
  "enctype": "multipart/form-data",
  "params": { "files": [{ "name": "photos", "accept": ["image/*"] }] }
}
```

Catch: the target URL has no fragment, so the service worker must know which
album to upload to — persist the last-used album in IndexedDB. Not on iOS.

Keep the service worker cautious: cache thumbnails and the app shell, never
cache list responses, or the gallery goes stale confusingly.

### 8.3 Other

- **Memory**: decoding 20 full-size photos at once crashes mobile Safari.
  Process sequentially; `close()` every `ImageBitmap`, `revokeObjectURL` every
  blob URL.
- **Presigned URL expiry**: SigV4 caps at 7 days. Re-sign per page load.
- **Clock skew**: SigV4 rejects requests with badly wrong client clocks. Rare,
  but the resulting `403 SignatureDoesNotMatch` is baffling — worth a specific
  error message.
- **Videos**: 4K files are large; thumbnailing needs a `<video>` + seek. Defer.
- **GitHub Pages** serves HTTPS on `*.github.io`, required for `crypto.subtle`,
  service workers, and `navigator.share`. Fine as-is.

---

## 9. Tech stack

Given limited JS experience: **no build step, no framework.**

- **Plain ES modules** (`<script type="module">`) served straight from the repo.
  Push to `main`, Pages serves it. No npm, no bundler, no toolchain to rot.
- **No framework.** This is a grid, a lightbox, and a settings panel. A
  `render()` that rebuilds the gallery from a state object is ~50 lines and will
  teach you more than React would. [Preact] via CDN import is an easy later step
  if it grows.
- **One vendored dependency**: [`aws4fetch`] (signing). Hashing, resizing,
  sharing and downloading are all native browser APIs. Vendor it as a single
  file rather than trusting a CDN to stay up.

As built:

```
index.html          shell: link / identity / gallery screens, lightbox, sheets
app.css             all styles; the token block is at the top
js/app.js           boot, screen routing, bulk save, error messages
js/album.js         decode #a=, validate, `ro` flag
js/backend-s3.js    list / get / put / remove / getJSON / putJSON / urlFor
js/photos.js        filename → record, frame numbers, hash set
js/identity.js      uid + name, localStorage, users/, colour-from-uid
js/exif.js          DateTimeOriginal out of a JPEG, and nothing else
js/seen.js          state/<uid>.json, lastSeenAt, downloaded, union merge
js/gallery.js       tiles, filter, marks, lazy presigning
js/lightbox.js      thumb → mid viewer, nav, save the original, delete
js/upload.js        hash → thumb + mid → put, with a progress sheet
js/share.js         canSaveToGallery branch, byte-budget batching, download fallback
js/ui.js            el / toast / confirm sheet / task sheet
lib/aws4fetch.js    vendored, MIT
tools/photoshare.py
spike/              Phase 0, kept as the reference for the proven patterns
```

Still to come (Phase 3): `manifest.json` + `sw.js` for PWA install and the
Android share target.

**No ZIP dependency.** `fflate` would have been the only third-party addition
beyond the signer, and only for desktop bulk download; sequential `<a download>`
clicks get there with one familiar Chrome prompt instead.

### 9.1 JS notes coming from another language

- `fetch()` returns a promise; `await` it in an `async function`. A non-2xx
  response does **not** throw — `fetch` rejects only on network failure, so
  always check `res.ok`. This surprises everyone.
- `Blob` = immutable bytes; `File` = `Blob` + name. Both go straight into
  `fetch` as a body, no encoding needed.
- `URL.createObjectURL(blob)` makes a local `blob:` URL for `<img src>`; it
  leaks until `revokeObjectURL`.
- `crypto.subtle` is async and HTTPS-only.
- `localStorage` is synchronous and strings-only — `JSON.stringify`/`parse`.
- `DOMParser` + `getElementsByTagNameNS('*', …)` for S3's XML. The non-NS
  variants can silently return nothing depending on namespace prefixes.

---

## 10. Roadmap

**Phase 0 — de-risk. ✅ COMPLETE (2026-07-27).** See `spike/index.html` for the
working patterns. Every unknown resolved on real hardware:

| Unknown | Result |
|---|---|
| CORS without configuration | ✅ works, zero setup |
| SigV4 signing in-browser (`aws4fetch`) | ✅ list + PUT |
| `ETag` readable from JS | ✅ `Expose-Headers: *` |
| Presigned `<img>` display | ✅ no CORS involved |
| Per-album IAM isolation (3 fences) | ✅ §2.2 |
| Upload expiry enforced | ✅ §2.3 |
| HEIC handling | ✅ Safari transcodes to JPEG on pick |
| Content-hash dedup across picks | ✅ §5.1 |
| **iOS save-to-photo-library** | ✅ single **and** 3-file batch |

A 3.3 MB photo uploaded from an iPhone in 0.8 s including on-device
thumbnailing. Nothing in this design is speculative any more.

**Phase 1 + 2 — the whole loop. Built.** Fragment parsing, S3 adapter, identity
with the "continue as" recovery list, upload with thumbnails and dedup, gallery
grid with per-person colours and filtering, lightbox, `state/<uid>.json`,
new/saved marks, save-all via `navigator.share`, desktop download fallback,
delete-your-own, progress and retry, view-only handling. See §7 and §9.

Two things Phase 1 settled that the plan had left open:

- **Bulk download on desktop is plain sequential downloads**, not a ZIP. See §9.
- **The `ro` flag** (§5.2) resolved open question 3 — the app hides write UI
  when the link says so, and still handles a 403 gracefully either way, which
  also covers a link whose `--expires` window has lapsed.

**Phase 3 — polish.** PWA manifest + service worker + Android share target,
per-file upload progress bars (needs `XMLHttpRequest`, §7.1), album cover.

**Phase 4 — optional.** ~~EXIF date extraction~~ **done (2026-07-28)**: `js/exif.js`
reads `DateTimeOriginal` at upload into `users/<uid>.json`, and the gallery sorts
by it (§7.2). Still open: videos (§11.2), captions — which now have an obvious
home in the same `photos` map — and an album cover.

---

## 11. Open questions

1. ~~**Originals or downscaled by default?**~~ **Settled: originals, always,
   with no toggle.** Storage is cheap (§3) and the point of the album is your
   friends' real photos — an option to quietly upload less than that defeats
   the app's whole reason to exist over a group chat. The toggle that briefly
   existed is gone; browsing cost is carried by `thumbs/` and `mid/` instead
   (§7.1), which is where it belonged.
2. **Do videos matter?** **Still open — deliberately deferred, 2026-07-28.** The
   picker line is one character of work; everything behind it is not. Costed
   out, in the order that would bite:

   - ~~**Bulk save is the real blocker.**~~ **Done, 2026-07-28.** `saveAll` now
     fetches one batch at a time immediately before its tap (§7.5), and the
     lightbox no longer prefetches originals at all (§7.6), so the explicit
     fetch-then-share structure a video needs already exists. What remains for
     videos here is a byte budget per batch rather than a flat count of ten.
   - **Hashing.** `crypto.subtle` has no streaming digest and
     `file.arrayBuffer()` on a long 4K clip kills mobile Safari. A video would
     have to hash its first ~16 MB plus its byte length; images must keep
     whole-file hashing so the dedup guarantee in §5.1 stays intact.
   - **Saving needs an extra tap.** The iOS gesture rule (§7.6) forbids awaiting
     a several-hundred-MB fetch inside the tap, so the lightbox Save button
     becomes Prepare → Save for videos.
   - **Posters.** `createImageBitmap` won't take a container; it needs a real
     `<video>`, muted + `playsinline`, seek, then `drawImage`. iOS declines for
     some codecs and Chrome can't decode HEVC at all, so "no poster" is a normal
     outcome and the tile needs a play badge rather than the `.nothumb` state.
   - **Playback is a non-goal.** iPhones record HEVC in `.mov` and do *not*
     transcode on pick the way they do for HEIC, so Android friends often can't
     play what gets uploaded. Accepted: the app is a download-to-camera-roll
     tool, not a viewer — but it means the lightbox must use
     `preload="none"` and never pretend a clip is browsable.
   - **Egress.** §3's model assumes browsing rides on derivatives. Twenty clips
     would demolish that; there is no cheap video equivalent of `mid/`.
3. ~~**Should the app detect a read-only key?**~~ **Settled: both.** The `ro`
   flag in the link (§5.2) hides the write UI with no probe request, and a 403
   on write is still handled with a specific message — which is what covers a
   writable link whose `--expires` window has since lapsed.
4. **One album per link, or a "my albums" list in `localStorage`?** The latter
   is pleasant but resets on iOS (§8.1). Still open — identity is already
   global across albums, so the list is the only missing piece.

---

## 12. Summary

Wasabi turns this from "blocked" into "straightforward". CORS — the thing that
killed the Nextcloud version — requires no configuration at all, because Wasabi
returns permissive headers unconditionally. The IAM API gives each album its own
prefix-scoped sub-user, so links are individually revocable and a leak is
contained to one trip. That's a materially better security model than the
Nextcloud share links you use today, not merely an equivalent one.

The CLI in `tools/photoshare.py` covers the lifecycle: create, list, re-issue,
revoke, delete. It runs as a sub-user fenced to one bucket and to `ps-*` IAM
users — no root key anywhere — read from 1Password at call time and never
written to disk.

Two things worth knowing before you build:

- **iOS "Save to Photos"** is historically unreliable via the Web Share API.
  Test it on a real device in Phase 0; the long-press fallback is decent.
- **Wasabi's egress fair-use ratio** is the one rule this workload naturally
  strains — but it's account-wide, and the 500 GB of backups already there give
  ample headroom. Thumbnails and delta-downloads keep it that way.

---

[wasabi-cors]: https://docs.wasabi.com/apidocs/bucket-cors-support-with-the-wasabi-s3-api
[wasabi-iam]: https://docs.wasabi.com/apidocs/iam-and-sts-support
[wasabi-sts]: https://docs.wasabi.com/docs/aws-sts-with-wasabi
[wasabi-egress]: https://wasabi.com/pricing/faq
[wasabi-delegate]: https://docs.wasabi.com/docs/veeam-v13-using-wasabi-iam-and-sts-authentication
[wacm]: https://docs.wasabi.com/v1/docs/how-do-i-use-purchased-storage-and-storage-utilization-in-wasabi-account-control-manager
[wasabi-policy]: https://docs.wasabi.com/docs/bucket-policy
[aws-size]: https://docs.aws.amazon.com/AmazonS3/latest/userguide/amazon-s3-policy-keys.html
[ios16]: https://developer.apple.com/forums/thread/729782
[`aws4fetch`]: https://github.com/mhart/aws4fetch
[Preact]: https://preactjs.com/
[caniwebview]: https://caniwebview.com/features/web-feature-share/
[ddg-webview]: https://github.com/orgs/privacyguides/discussions/414
[ffshare]: https://developer.mozilla.org/en-US/docs/Web/API/Navigator/share
