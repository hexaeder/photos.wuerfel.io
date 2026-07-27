#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["boto3"]
# ///
"""
photoshare — manage Wasabi-backed shared photo albums.

Each album is a prefix in one bucket plus a dedicated IAM sub-user whose
credentials are baked into a shareable link. Revoking an album deletes the
sub-user; the photos are untouched.

The CLI runs as a Wasabi sub-user fenced to one bucket and to IAM users named
ps-* (see `admin-policy`). Its key is read from 1Password via the `op` CLI at
call time and never touches disk. No root access key is involved.

Usage (chmod +x once, then uv resolves deps automatically):
    ./photoshare.py admin-policy            # policy for this CLI's own sub-user
    ./photoshare.py init                    # verify access, one time
    ./photoshare.py list
    ./photoshare.py create "Norway 2026"
    ./photoshare.py link norway-2026        # re-issue (rotates the key)
    ./photoshare.py revoke norway-2026      # kill the link, keep photos
    ./photoshare.py rm norway-2026          # revoke + delete photos
    ./photoshare.py info norway-2026
    ./photoshare.py check --revoke          # quota watchdog, for cron

Config, first match wins:  $PHOTOSHARE_CONFIG
                           tools/config.toml   (beside this script)
                           ~/.config/photoshare.toml
    bucket    = "photoshare-wuerfel"
    region    = "eu-central-2"                    # Frankfurt
    site      = "https://photos.wuerfel.io/"
    op_key    = "op://Private/Wasabi/access key id"
    op_secret = "op://Private/Wasabi/secret access key"
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import time
import tomllib
import unicodedata
from datetime import datetime, timedelta, timezone
from functools import cache
from pathlib import Path
from urllib.parse import unquote

import boto3
from botocore.exceptions import ClientError

# Searched in order; first hit wins. config.toml beside the script keeps the
# whole tool self-contained, which is why it outranks the XDG location.
CONFIG_CANDIDATES = (
    Path(os.environ["PHOTOSHARE_CONFIG"]) if os.environ.get("PHOTOSHARE_CONFIG") else None,
    Path(__file__).resolve().parent / "config.toml",
    Path.home() / ".config" / "photoshare.toml",
)
ALBUM_ROOT = "albums/"
USER_PREFIX = "ps-"

# Wasabi's IAM endpoint is global and always signs against us-east-1.
IAM_ENDPOINT = "https://iam.wasabisys.com"
IAM_REGION = "us-east-1"


# --------------------------------------------------------------------------
# config & credentials
# --------------------------------------------------------------------------


@cache
def config() -> dict:
    path = next((p for p in CONFIG_CANDIDATES if p and p.exists()), None)
    if path is None:
        searched = "\n".join(f"  {p}" for p in CONFIG_CANDIDATES if p)
        die(
            f"no config found. Searched:\n{searched}\n\n"
            "Create it with:\n\n"
            '    bucket    = "photoshare-wuerfel"   # globally unique across Wasabi\n'
            '    region    = "eu-central-2"         # Frankfurt\n'
            '    site      = "https://photos.wuerfel.io/"\n'
            '    op_key    = "op://Private/Wasabi/access key id"\n'
            '    op_secret = "op://Private/Wasabi/secret access key"\n\n'
            "The op_* values are 1Password references, not secrets, so this\n"
            "file is safe at rest. Then run `photoshare.py admin-policy` to get\n"
            "the policy for the sub-user whose key those references point at."
        )
    try:
        cfg = tomllib.loads(path.read_text())
    except tomllib.TOMLDecodeError as e:
        die(f"{path}: invalid TOML — {e}")
    missing = {"bucket", "region", "site", "op_key", "op_secret"} - cfg.keys()
    if missing:
        die(f"{path}: missing keys: {', '.join(sorted(missing))}")
    return cfg


def op_read(ref: str) -> str:
    """Read a single field out of 1Password. Requires an unlocked `op` session."""
    try:
        out = subprocess.run(
            ["op", "read", ref],
            capture_output=True,
            text=True,
            check=True,
        )
    except FileNotFoundError:
        die("the 1Password CLI (`op`) is not installed or not on PATH")
    except subprocess.CalledProcessError as e:
        die(f"op read {ref!r} failed:\n{e.stderr.strip()}")
    return out.stdout.strip()


@cache
def credentials() -> tuple[str, str]:
    cfg = config()
    return op_read(cfg["op_key"]), op_read(cfg["op_secret"])


@cache
def s3():
    key, secret = credentials()
    return boto3.client(
        "s3",
        endpoint_url=f"https://s3.{config()['region']}.wasabisys.com",
        region_name=config()["region"],
        aws_access_key_id=key,
        aws_secret_access_key=secret,
    )


@cache
def iam():
    key, secret = credentials()
    return boto3.client(
        "iam",
        endpoint_url=IAM_ENDPOINT,
        region_name=IAM_REGION,
        aws_access_key_id=key,
        aws_secret_access_key=secret,
    )


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


def die(msg: str, code: int = 1):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)


UMLAUTS = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss"})


def slugify(title: str) -> str:
    # Expand German umlauts before stripping accents, so "Süd" becomes "sued"
    # rather than "sd". Everything else degrades to its unaccented form.
    folded = title.lower().translate(UMLAUTS)
    folded = unicodedata.normalize("NFKD", folded).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", folded).strip("-")
    if not slug:
        die(f"cannot derive a slug from {title!r} — pass --slug")
    return slug[:48]


def album_prefix(slug: str) -> str:
    return f"{ALBUM_ROOT}{slug}/"


def user_name(slug: str) -> str:
    return f"{USER_PREFIX}{slug}"


def human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024


def admin_policy(bucket: str, account: str = "*") -> dict:
    """
    Policy for the sub-user that *runs this CLI*.

    Two fences: S3 is limited to the photoshare bucket, and IAM is limited to
    users named ps-* — so it cannot touch your backup buckets or any pre-existing
    user. See the caveat in DESIGN.md §4.1 about IAM-write escalation.
    """
    return {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Sid": "PhotoshareBucketOnly",
                "Effect": "Allow",
                "Action": "s3:*",
                "Resource": [
                    f"arn:aws:s3:::{bucket}",
                    f"arn:aws:s3:::{bucket}/*",
                ],
            },
            {
                # ListUsers cannot be resource-scoped; it is read-only and
                # reveals only user names, so granting it broadly is fine.
                "Sid": "EnumerateUsers",
                "Effect": "Allow",
                "Action": ["iam:ListUsers", "sts:GetCallerIdentity"],
                "Resource": "*",
            },
            {
                "Sid": "ManageAlbumUsersOnly",
                "Effect": "Allow",
                "Action": [
                    "iam:CreateUser",
                    "iam:DeleteUser",
                    "iam:GetUser",
                    "iam:PutUserPolicy",
                    "iam:GetUserPolicy",
                    "iam:DeleteUserPolicy",
                    "iam:ListUserPolicies",
                    "iam:CreateAccessKey",
                    "iam:DeleteAccessKey",
                    "iam:ListAccessKeys",
                ],
                "Resource": f"arn:aws:iam::{account}:user/{USER_PREFIX}*",
            },
        ],
    }


def parse_duration(s: str) -> timedelta | None:
    """'30d' / '6w' / '48h' -> timedelta. 'never' -> None."""
    if s.lower() in ("never", "none", "0"):
        return None
    m = re.fullmatch(r"(\d+)\s*([hdw])", s.strip().lower())
    if not m:
        die(f"bad duration {s!r} — use e.g. 30d, 6w, 48h, or never")
    n, unit = int(m[1]), m[2]
    return {"h": timedelta(hours=n), "d": timedelta(days=n), "w": timedelta(weeks=n)}[unit]


def iso_z(dt: datetime) -> str:
    """IAM wants '2026-08-26T00:00:00Z', not Python's '+00:00'."""
    return dt.astimezone(timezone.utc).replace(microsecond=0, tzinfo=None).isoformat() + "Z"


def album_policy(
    bucket: str, prefix: str, readonly: bool, write_until: str | None = None
) -> dict:
    """
    Least-privilege policy: one album prefix, nothing else in the account.

    Read and write are separate statements so that an expiry can gate uploads
    while leaving the gallery readable forever — which is what a trip album
    actually wants, and which bounds the upload-abuse window without monitoring.
    """
    statements = [
        {
            "Sid": "ListOwnAlbumOnly",
            "Effect": "Allow",
            "Action": "s3:ListBucket",
            "Resource": f"arn:aws:s3:::{bucket}",
            # Without this condition the key could enumerate every album
            # in the bucket. It is the load-bearing line in this policy.
            "Condition": {"StringLike": {"s3:prefix": [f"{prefix}*"]}},
        },
        {
            "Sid": "ReadOwnAlbum",
            "Effect": "Allow",
            "Action": "s3:GetObject",
            "Resource": f"arn:aws:s3:::{bucket}/{prefix}*",
        },
    ]
    if not readonly:
        write = {
            "Sid": "WriteOwnAlbum",
            "Effect": "Allow",
            "Action": ["s3:PutObject", "s3:DeleteObject"],
            "Resource": f"arn:aws:s3:::{bucket}/{prefix}*",
        }
        if write_until:
            write["Condition"] = {"DateLessThan": {"aws:CurrentTime": write_until}}
        statements.append(write)
    return {"Version": "2012-10-17", "Statement": statements}


def policy_expiry(user: str) -> str | None:
    """Read the write-window expiry back out of a live IAM policy."""
    try:
        doc = iam().get_user_policy(UserName=user, PolicyName="album-access")[
            "PolicyDocument"
        ]
    except ClientError:
        return None
    if isinstance(doc, str):                       # some endpoints url-encode it
        doc = json.loads(unquote(doc))
    for st in doc.get("Statement", []):
        if st.get("Sid") == "WriteOwnAlbum":
            return st.get("Condition", {}).get("DateLessThan", {}).get("aws:CurrentTime")
    return None


def make_link(slug: str, title: str, access_key: str, secret_key: str) -> str:
    cfg = config()
    payload = {
        "v": 1,
        "t": "s3",
        "ep": f"https://s3.{cfg['region']}.wasabisys.com",
        "rg": cfg["region"],
        "b": cfg["bucket"],
        "p": album_prefix(slug),
        "k": access_key,
        "s": secret_key,
        "n": title,
    }
    blob = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":")).encode()
    ).decode().rstrip("=")
    return f"{cfg['site'].rstrip('/')}/#a={blob}"


def iter_objects(prefix: str):
    """Current objects — what the gallery shows."""
    paginator = s3().get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=config()["bucket"], Prefix=prefix):
        yield from page.get("Contents", [])


def iter_versions(prefix: str):
    """
    Every version and delete marker under a prefix.

    Versioning is on, so non-current versions keep occupying (and costing)
    storage after a delete. Quota checks and real deletion must use this, not
    iter_objects, or they will both be wrong in the same direction.
    """
    paginator = s3().get_paginator("list_object_versions")
    for page in paginator.paginate(Bucket=config()["bucket"], Prefix=prefix):
        yield from page.get("Versions", [])
        yield from page.get("DeleteMarkers", [])


def read_album_json(slug: str) -> dict | None:
    try:
        body = s3().get_object(
            Bucket=config()["bucket"], Key=f"{album_prefix(slug)}album.json"
        )["Body"].read()
        return json.loads(body)
    except (ClientError, json.JSONDecodeError):
        return None


def known_slugs() -> list[str]:
    """Albums are discovered from the bucket, so there is no local state."""
    resp = s3().list_objects_v2(
        Bucket=config()["bucket"], Prefix=ALBUM_ROOT, Delimiter="/"
    )
    return sorted(
        p["Prefix"][len(ALBUM_ROOT):].rstrip("/")
        for p in resp.get("CommonPrefixes", [])
    )


def album_users(slug: str) -> list[str]:
    """Every sub-user currently holding a key for this album."""
    want = user_name(slug)
    found = []
    paginator = iam().get_paginator("list_users")
    for page in paginator.paginate():
        for u in page["Users"]:
            if u["UserName"] == want or u["UserName"].startswith(want + "-"):
                found.append(u["UserName"])
    return sorted(found)


def destroy_user(name: str):
    """Keys and inline policies must go before the user itself."""
    client = iam()
    try:
        for k in client.list_access_keys(UserName=name)["AccessKeyMetadata"]:
            client.delete_access_key(UserName=name, AccessKeyId=k["AccessKeyId"])
        for p in client.list_user_policies(UserName=name)["PolicyNames"]:
            client.delete_user_policy(UserName=name, PolicyName=p)
        client.delete_user(UserName=name)
    except ClientError as e:
        if e.response["Error"]["Code"] != "NoSuchEntity":
            raise


def provision_user(
    slug: str, readonly: bool, write_until: str | None = None
) -> tuple[str, str]:
    """Create the sub-user, attach the album policy, mint a key."""
    cfg = config()
    name = user_name(slug) + ("-ro" if readonly else "")
    client = iam()

    try:
        client.create_user(UserName=name)
    except ClientError as e:
        if e.response["Error"]["Code"] != "EntityAlreadyExists":
            raise

    client.put_user_policy(
        UserName=name,
        PolicyName="album-access",
        PolicyDocument=json.dumps(
            album_policy(cfg["bucket"], album_prefix(slug), readonly, write_until)
        ),
    )

    # Wasabi caps a sub-user at 2 keys; clear old ones so re-issuing is idempotent.
    for k in client.list_access_keys(UserName=name)["AccessKeyMetadata"]:
        client.delete_access_key(UserName=name, AccessKeyId=k["AccessKeyId"])

    key = client.create_access_key(UserName=name)["AccessKey"]
    return key["AccessKeyId"], key["SecretAccessKey"]


def confirm(prompt: str):
    if input(f"{prompt} [y/N] ").strip().lower() not in ("y", "yes"):
        die("aborted", code=130)


# --------------------------------------------------------------------------
# commands
# --------------------------------------------------------------------------


def cmd_list(args):
    slugs = known_slugs()
    if not slugs:
        print("no albums yet — try: photoshare.py create \"My Trip\"")
        return

    now = iso_z(datetime.now(timezone.utc))
    rows = []
    for slug in slugs:
        meta = read_album_json(slug) or {}
        objs = list(iter_objects(f"{album_prefix(slug)}photos/"))
        users = album_users(slug)

        if not users:
            status = "revoked"
        else:
            until = policy_expiry(user_name(slug)) if user_name(slug) in users else None
            if until is None:
                status = "open"
            elif until < now:
                status = "read-only"          # window closed, gallery still works
            else:
                status = f"until {until[:10]}"

        rows.append(
            (
                slug,
                meta.get("title", "?"),
                str(len(objs)),
                human(sum(o["Size"] for o in objs)),
                status,
            )
        )

    headers = ("SLUG", "TITLE", "PHOTOS", "SIZE", "UPLOADS")
    widths = [max(len(r[i]) for r in (*rows, headers)) for i in range(5)]
    fmt = "  ".join(f"{{:<{w}}}" for w in widths)
    print(fmt.format(*headers))
    for r in rows:
        print(fmt.format(*r))


def cmd_create(args):
    cfg = config()
    title = args.title
    slug = args.slug or slugify(title)

    if slug in known_slugs():
        die(f"album {slug!r} already exists (use `link` to re-issue its URL)")

    now = datetime.now(timezone.utc).isoformat()
    s3().put_object(
        Bucket=cfg["bucket"],
        Key=f"{album_prefix(slug)}album.json",
        Body=json.dumps(
            {"schemaVersion": 1, "slug": slug, "title": title, "createdAt": now},
            indent=2,
        ).encode(),
        ContentType="application/json",
    )

    delta = parse_duration(args.expires)
    write_until = iso_z(datetime.now(timezone.utc) + delta) if delta else None

    access_key, secret_key = provision_user(slug, readonly=False, write_until=write_until)
    link = make_link(slug, title, access_key, secret_key)

    print(f"created album {slug!r} ({title})\n")
    print(f"  upload+view link:\n  {link}\n")

    if write_until:
        print(f"  uploads allowed until {write_until}; viewing stays open.")
        print(f"  extend with: ./photoshare.py extend {slug} 30d\n")
    else:
        print("  uploads never expire (--expires never). Consider `check` (§2.3).\n")

    if args.readonly_link:
        ro_key, ro_secret = provision_user(slug, readonly=True)
        print(f"  view-only link:\n  {make_link(slug, title, ro_key, ro_secret)}\n")

    if args.save:
        subprocess.run(
            ["op", "item", "create", "--category", "Secure Note",
             f"--title=photoshare: {title}", f"link[url]={link}"],
            check=False,
        )
        print("  saved to 1Password")

    print("  The secret is in the link and is not stored anywhere else.")
    print("  Lost it? `photoshare.py link " + slug + "` issues a new one.")


def cmd_link(args):
    slug = args.slug
    if slug not in known_slugs():
        die(f"no such album: {slug}")
    meta = read_album_json(slug) or {}
    title = meta.get("title", slug)

    confirm(f"Re-issuing rotates the key and breaks the existing link for {slug!r}. Continue?")
    access_key, secret_key = provision_user(slug, readonly=args.readonly)
    print(f"\n  {make_link(slug, title, access_key, secret_key)}\n")
    print("  The previous link is now dead.")


def cmd_extend(args):
    """
    Move the upload deadline. Rewrites the policy only — the access key is
    untouched, so the link people already have keeps working.
    """
    cfg = config()
    slug = args.slug
    if slug not in known_slugs():
        die(f"no such album: {slug}")

    name = user_name(slug)
    if name not in album_users(slug):
        die(f"{slug} has no live upload link — re-issue with `link {slug}`")

    delta = parse_duration(args.duration)
    write_until = iso_z(datetime.now(timezone.utc) + delta) if delta else None

    iam().put_user_policy(
        UserName=name,
        PolicyName="album-access",
        PolicyDocument=json.dumps(
            album_policy(cfg["bucket"], album_prefix(slug), False, write_until)
        ),
    )
    if write_until:
        print(f"{slug}: uploads now allowed until {write_until}")
    else:
        print(f"{slug}: upload expiry removed")
    print("The existing link still works — no need to re-share it.")


def _probe_client(name: str, policy: dict):
    """
    Fresh throwaway user with exactly one policy, never mutated afterwards.

    Creating rather than updating matters: an updated policy can be served stale
    for a while, which silently turns a real DENY into an apparent ALLOW.
    """
    cfg = config()
    destroy_user(name)                      # clean slate from any earlier run
    iam().create_user(UserName=name)
    iam().put_user_policy(
        UserName=name, PolicyName="album-access", PolicyDocument=json.dumps(policy)
    )
    key = iam().create_access_key(UserName=name)["AccessKey"]
    return boto3.client(
        "s3",
        endpoint_url=f"https://s3.{cfg['region']}.wasabisys.com",
        region_name=cfg["region"],
        aws_access_key_id=key["AccessKeyId"],
        aws_secret_access_key=key["SecretAccessKey"],
    )


def _denied(exc: ClientError) -> bool:
    return exc.response["Error"]["Code"] in ("AccessDenied", "403", "AllAccessDisabled")


def _wait_live(label: str, action, max_wait: int) -> bool:
    """Poll an action that MUST succeed, to prove the key has propagated."""
    deadline = time.monotonic() + max_wait
    while time.monotonic() < deadline:
        try:
            action()
            return True
        except ClientError as e:
            if not _denied(e):
                raise
            time.sleep(3)
    print(f"  {label:<40} NEVER BECAME LIVE")
    return False


def _expect_deny(label: str, action, settle: int) -> bool:
    """
    Poll an action that must stay denied for the whole settle window.

    A single denial proves nothing (the key may not be live yet); a single
    success anywhere in the window disproves enforcement outright.
    """
    deadline = time.monotonic() + settle
    while time.monotonic() < deadline:
        try:
            action()
            print(f"  {label:<40} ALLOWED  <-- not enforced")
            return False
        except ClientError as e:
            if not _denied(e):
                raise
            time.sleep(3)
    print(f"  {label:<40} denied")
    return True


def cmd_selftest(args):
    """
    Measure which policy conditions Wasabi actually enforces.

    Wasabi documents neither its supported nor its unsupported condition keys,
    so all three fences in the security model are assumptions until tested on a
    live account. Each test uses a fresh user, and each denial is only believed
    after the same key has demonstrably worked for something else.
    """
    cfg = config()
    bucket = cfg["bucket"]
    a, b = f"{ALBUM_ROOT}.selftest-a/", f"{ALBUM_ROOT}.selftest-b/"
    users = [f"{USER_PREFIX}selftest-time", f"{USER_PREFIX}selftest-scope"]
    results = {}

    # A canary in the *other* album, so a cross-album read that is permitted
    # returns 200 rather than a misleading NoSuchKey.
    s3().put_object(Bucket=bucket, Key=f"{b}canary.txt", Body=b"canary")
    s3().put_object(Bucket=bucket, Key=f"{a}canary.txt", Body=b"canary")

    try:
        # ---- 1. time condition: read allowed, write expired ----------------
        print("time condition (DateLessThan on aws:CurrentTime)")
        expired = iso_z(datetime.now(timezone.utc) - timedelta(days=1))
        c = _probe_client(users[0], album_policy(bucket, a, False, expired))
        live = _wait_live(
            "  control: read own album",
            lambda: c.get_object(Bucket=bucket, Key=f"{a}canary.txt"),
            args.max_wait,
        )
        if not live:
            die("key never became live; cannot conclude anything", code=3)
        print(f"  {'control: read own album':<40} allowed")
        results["time"] = _expect_deny(
            "  test: write after expiry",
            lambda: c.put_object(Bucket=bucket, Key=f"{a}probe.txt", Body=b"x"),
            args.settle,
        )

        # ---- 2. prefix condition + 3. resource fence -----------------------
        print("\nprefix condition (StringLike on s3:prefix) and resource fence")
        c = _probe_client(users[1], album_policy(bucket, a, False, None))
        live = _wait_live(
            "  control: list own album",
            lambda: c.list_objects_v2(Bucket=bucket, Prefix=a),
            args.max_wait,
        )
        if not live:
            die("key never became live; cannot conclude anything", code=3)
        print(f"  {'control: list own album':<40} allowed")
        results["prefix"] = _expect_deny(
            "  test: list whole bucket",
            lambda: c.list_objects_v2(Bucket=bucket),
            args.settle,
        )
        results["resource"] = _expect_deny(
            "  test: read another album",
            lambda: c.get_object(Bucket=bucket, Key=f"{b}canary.txt"),
            args.settle,
        )
    finally:
        for u in users:
            destroy_user(u)
        for prefix in (a, b):
            for v in iter_versions(prefix):
                s3().delete_object(
                    Bucket=bucket, Key=v["Key"], VersionId=v.get("VersionId", "null")
                )
        print("\ncleaned up throwaway users and probe objects")

    print()
    for kind, label in (
        ("resource", "Album key cannot reach another album's objects"),
        ("prefix", "Album key cannot enumerate other albums"),
        ("time", "Upload expiry (--expires) is enforced"),
    ):
        print(f"  {'PASS' if results[kind] else 'FAIL'}  {label}")

    if not results["resource"]:
        die(
            "\nCRITICAL: the Resource fence is not enforced. The whole "
            "per-album\nisolation model is invalid on this account. Stop and "
            "reconsider\nthe design before storing anything real.",
            code=4,
        )
    if not results["prefix"]:
        print(
            "\nWARNING: s3:prefix conditions are ignored, so an album key can "
            "list\nevery album's object *names* (not their contents — the "
            "Resource fence\nstill blocks reads). See DESIGN.md §2.2."
        )
    if not results["time"]:
        print(
            "\n--expires is NOT a control on this account. Create albums with\n"
            "`--expires never` and rely on `check --revoke` from cron (§2.3)."
        )
    if all(results.values()):
        print("\nAll three fences hold. `--expires` is real; cron is optional.")


def cmd_revoke(args):
    slug = args.slug
    users = album_users(slug)
    if not users:
        print(f"{slug}: no live links")
        return
    confirm(f"Revoke {len(users)} link(s) for {slug!r}? Photos are kept.")
    for name in users:
        destroy_user(name)
        print(f"  revoked {name}")


def cmd_rm(args):
    cfg = config()
    slug = args.slug
    if slug not in known_slugs():
        die(f"no such album: {slug}")

    objs = list(iter_objects(album_prefix(slug)))
    total = sum(o["Size"] for o in objs)

    print(f"{slug}: {len(objs)} objects, {human(total)}")
    print(
        "\nNote: Wasabi bills a 90-day minimum storage duration. Deleting now\n"
        "still costs the remaining days, and you pay the 1 TB monthly minimum\n"
        "regardless — so `revoke` is usually the better move.\n"
    )
    confirm(f"Permanently delete all objects under {album_prefix(slug)}?")

    # Delete by VersionId. A plain delete under versioning only writes a delete
    # marker: the bytes stay, and you keep paying for them.
    batch, deleted = [], 0

    def flush():
        nonlocal batch, deleted
        if batch:
            s3().delete_objects(Bucket=cfg["bucket"], Delete={"Objects": batch})
            deleted += len(batch)
            batch = []

    for v in iter_versions(album_prefix(slug)):
        batch.append({"Key": v["Key"], "VersionId": v["VersionId"]})
        if len(batch) == 1000:
            flush()
    flush()

    for name in album_users(slug):
        destroy_user(name)

    print(f"  deleted {deleted} versions and revoked all links")


def cmd_check(args):
    """
    Quota watchdog. Neither S3 nor Wasabi can cap how much a valid key uploads,
    so the only available control is to notice quickly and revoke. Run from
    cron; the interval is what actually bounds your worst case.

    Exits non-zero if anything is over, so cron mails you.
    """
    cfg = config()
    album_gb = args.album_gb or cfg.get("album_quota_gb", 50)
    total_gb = args.total_gb or cfg.get("total_quota_gb", 400)

    breaches, total = [], 0
    print(f"{'ALBUM':<28} {'BILLABLE':>10}  {'QUOTA':>8}  STATUS")
    for slug in known_slugs():
        # Billable bytes include non-current versions, so this is deliberately
        # not the number `list` shows.
        size = sum(v.get("Size", 0) for v in iter_versions(album_prefix(slug)))
        total += size
        over = size > album_gb * 1024**3
        if over:
            breaches.append((slug, size))
        print(f"{slug:<28} {human(size):>10}  {album_gb:>6} GB  {'OVER' if over else 'ok'}")

    total_over = total > total_gb * 1024**3
    print(f"\n{'total':<28} {human(total):>10}  {total_gb:>6} GB  {'OVER' if total_over else 'ok'}")

    if not breaches and not total_over:
        return

    if args.revoke and breaches:
        print()
        for slug, _ in breaches:
            for name in album_users(slug):
                destroy_user(name)
            print(f"  revoked all links for {slug}")
        print("\nLinks are dead; the data is still there. Inspect before `rm`.")
    elif breaches:
        print("\nRe-run with --revoke to kill the offending links, or:")
        for slug, _ in breaches:
            print(f"  ./photoshare.py revoke {slug}")

    sys.exit(2)


def cmd_info(args):
    slug = args.slug
    if slug not in known_slugs():
        die(f"no such album: {slug}")

    meta = read_album_json(slug) or {}
    photos = list(iter_objects(f"{album_prefix(slug)}photos/"))
    thumbs = list(iter_objects(f"{album_prefix(slug)}thumbs/"))

    # Filenames are <epoch>-<uid>-<hash>.<ext>, so the uid is field 2.
    by_user: dict[str, int] = {}
    for o in photos:
        parts = o["Key"].split("/")[-1].split("-")
        uid = parts[1] if len(parts) >= 3 else "?"
        by_user[uid] = by_user.get(uid, 0) + 1

    names = {}
    for o in iter_objects(f"{album_prefix(slug)}users/"):
        try:
            u = json.loads(
                s3().get_object(Bucket=config()["bucket"], Key=o["Key"])["Body"].read()
            )
            names[u.get("uid", "")] = u.get("name", "")
        except (ClientError, json.JSONDecodeError):
            pass

    print(f"album:    {meta.get('title', slug)}  ({slug})")
    print(f"created:  {meta.get('createdAt', '?')}")
    print(f"photos:   {len(photos)}  ({human(sum(o['Size'] for o in photos))})")
    print(f"thumbs:   {len(thumbs)}")
    print(f"links:    {', '.join(album_users(slug)) or 'none (revoked)'}")
    if by_user:
        print("uploads by:")
        for uid, n in sorted(by_user.items(), key=lambda kv: -kv[1]):
            print(f"  {names.get(uid, uid):<20} {n}")


def cmd_admin_policy(args):
    """Print the policy to attach to the sub-user that runs this CLI."""
    cfg = config()
    print(json.dumps(admin_policy(cfg["bucket"], args.account), indent=2))
    print(
        "\n# Paste into Wasabi console -> Policies -> Create Policy, then attach\n"
        "# it to the sub-user whose keys you put in 1Password.\n"
        f"# If Wasabi rejects the wildcard account in the IAM ARN, rerun with\n"
        f"#   --account <your-account-id>   (console -> Settings)",
        file=sys.stderr,
    )


def cmd_init(args):
    """Verify access and prepare the bucket. Safe to re-run."""
    cfg = config()
    warned = False

    print("reading credentials from 1Password ...")
    try:
        iam().list_users(MaxItems=1)
        print("  ok  IAM reachable")
    except ClientError as e:
        die(
            f"IAM rejected these credentials ({e.response['Error']['Code']}).\n"
            "The CLI needs iam:ListUsers plus user management on "
            f"{USER_PREFIX}* — see `photoshare.py admin-policy`."
        )

    # The bucket may already exist because you created it by hand; that is the
    # recommended path, so treat creation as a fallback rather than the norm.
    try:
        s3().head_bucket(Bucket=cfg["bucket"])
        print(f"  ok  bucket {cfg['bucket']} reachable")
    except ClientError as e:
        code = str(e.response["Error"]["Code"])
        if code in ("403", "AccessDenied"):
            die(
                f"bucket {cfg['bucket']!r} exists but these credentials cannot "
                "reach it.\nCheck the s3:* statement in the sub-user's policy."
            )
        if code not in ("404", "NoSuchBucket"):
            raise

        print(f"  --  bucket {cfg['bucket']} not found, creating ...")
        # us-east-1 is the S3 default; sending it as a LocationConstraint errors.
        kwargs = {"Bucket": cfg["bucket"]}
        if cfg["region"] != "us-east-1":
            kwargs["CreateBucketConfiguration"] = {"LocationConstraint": cfg["region"]}
        try:
            s3().create_bucket(**kwargs)
            print(f"  ok  created {cfg['bucket']} in {cfg['region']}")
        except ClientError as ce:
            ccode = ce.response["Error"]["Code"]
            if ccode == "BucketAlreadyExists":
                die(
                    f"the name {cfg['bucket']!r} is taken by another Wasabi "
                    "customer.\nBucket names are global — pick a more specific one."
                )
            if ccode in ("AccessDenied", "403"):
                die(
                    f"not allowed to create buckets with this key.\n"
                    f"Create {cfg['bucket']!r} in the console (region "
                    f"{cfg['region']}), then re-run init."
                )
            raise

    # Versioning turns an accidental (or malicious) delete into an undo.
    if args.no_versioning:
        print("  --  skipping versioning (--no-versioning)")
    else:
        try:
            s3().put_bucket_versioning(
                Bucket=cfg["bucket"], VersioningConfiguration={"Status": "Enabled"}
            )
            print("  ok  versioning enabled")
        except ClientError as e:
            warned = True
            print(
                f"  !!  could not enable versioning ({e.response['Error']['Code']}).\n"
                "      Without it there is no undo for a mass delete."
            )

    # End-to-end write probe: the album flow is worthless if PUT is denied.
    probe = f"{ALBUM_ROOT}.photoshare-init"
    try:
        s3().put_object(
            Bucket=cfg["bucket"],
            Key=probe,
            Body=json.dumps({"initialisedAt": datetime.now(timezone.utc).isoformat()}).encode(),
            ContentType="application/json",
        )
        print("  ok  write access confirmed")
    except ClientError as e:
        die(f"cannot write to the bucket ({e.response['Error']['Code']}).")

    print("\nNo CORS setup needed — Wasabi returns permissive headers by default.")
    if warned:
        print("Fix the warning above before relying on this for real photos.")
    print('\nNext: ./photoshare.py create "My Trip"')


# --------------------------------------------------------------------------


def main():
    p = argparse.ArgumentParser(
        prog="photoshare", description=__doc__.split("\n\n")[1]
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("admin-policy", help="print the policy for the CLI's own sub-user")
    c.add_argument("--account", default="*", help="Wasabi account id (default: wildcard)")
    c.set_defaults(fn=cmd_admin_policy)

    c = sub.add_parser("init", help="verify access and prepare the bucket")
    c.add_argument(
        "--no-versioning", action="store_true",
        help="do not enable bucket versioning (you lose undo for deletes)",
    )
    c.set_defaults(fn=cmd_init)
    sub.add_parser("list", help="list albums").set_defaults(fn=cmd_list)

    c = sub.add_parser("create", help="create an album and print its link")
    c.add_argument("title")
    c.add_argument("--slug", help="override the derived slug")
    c.add_argument("--readonly-link", action="store_true", help="also mint a view-only link")
    c.add_argument("--save", action="store_true", help="store the link in 1Password")
    c.add_argument(
        "--expires", default="30d",
        help="upload window, e.g. 30d / 6w / never (default: 30d). Viewing never expires.",
    )
    c.set_defaults(fn=cmd_create)

    c = sub.add_parser("extend", help="move the upload deadline; link keeps working")
    c.add_argument("slug")
    c.add_argument("duration", help="e.g. 30d, 6w, never")
    c.set_defaults(fn=cmd_extend)

    c = sub.add_parser(
        "selftest", help="verify which policy fences Wasabi enforces (run once)"
    )
    c.add_argument("--settle", type=int, default=30,
                   help="seconds a denial must hold to be believed (default 30)")
    c.add_argument("--max-wait", type=int, default=90,
                   help="seconds to wait for a new key to go live (default 90)")
    c.set_defaults(fn=cmd_selftest)

    c = sub.add_parser("link", help="re-issue an album link (rotates the key)")
    c.add_argument("slug")
    c.add_argument("--readonly", action="store_true")
    c.set_defaults(fn=cmd_link)

    c = sub.add_parser("revoke", help="kill all links, keep the photos")
    c.add_argument("slug")
    c.set_defaults(fn=cmd_revoke)

    c = sub.add_parser("rm", help="delete the photos and revoke the links")
    c.add_argument("slug")
    c.set_defaults(fn=cmd_rm)

    c = sub.add_parser("check", help="quota watchdog; exits 2 if over (for cron)")
    c.add_argument("--album-gb", type=float, help="per-album limit")
    c.add_argument("--total-gb", type=float, help="bucket-wide limit")
    c.add_argument("--revoke", action="store_true", help="auto-revoke offenders")
    c.set_defaults(fn=cmd_check)

    c = sub.add_parser("info", help="show album statistics")
    c.add_argument("slug")
    c.set_defaults(fn=cmd_info)

    args = p.parse_args()
    try:
        args.fn(args)
    except ClientError as e:
        die(f"{e.response['Error']['Code']}: {e.response['Error'].get('Message', '')}")
    except KeyboardInterrupt:
        sys.exit(130)


if __name__ == "__main__":
    main()
