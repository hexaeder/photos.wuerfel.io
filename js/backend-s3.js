import { AwsClient } from '../lib/aws4fetch.js';

// Entry: { path, name, size, mtime, etag } — path is relative to the album
// prefix, so callers never think about bucket layout.
//
//   list(dir)       -> Entry[]
//   get(path)       -> Blob
//   put(path, blob) -> void
//   remove(path)    -> void
//   urlFor(path)    -> presigned URL, straight into <img src>
//
// urlFor is async because S3 objects are private and the URL must be signed.
// Worth it: the browser then handles fetching, caching and progressive decode
// natively instead of blobs being shuttled through JS.

/** S3 errors are XML. Pull the code out so messages say something useful. */
async function s3Error(res, what) {
  const body = await res.text().catch(() => '');
  const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1];
  const err = new Error(`${what}: ${res.status}${code ? ` ${code}` : ''}`);
  err.status = res.status;
  err.code = code;
  return err;
}

export function s3Backend({ ep, rg, b, p, k, s }) {
  const aws = new AwsClient({
    accessKeyId: k, secretAccessKey: s, region: rg, service: 's3',
  });
  const url = (path) => `${ep}/${b}/${p}${path}`;

  async function list(dir = '') {
    const out = [];
    let token;
    do {
      const u = new URL(`${ep}/${b}`);
      u.searchParams.set('list-type', '2');
      u.searchParams.set('prefix', p + dir);   // the IAM policy requires this
      if (token) u.searchParams.set('continuation-token', token);

      const res = await aws.fetch(u);
      if (!res.ok) throw await s3Error(res, `list ${dir || '/'}`);

      const xml = new DOMParser().parseFromString(await res.text(), 'text/xml');
      // S3's XML is namespaced; the *NS variants avoid prefix surprises.
      const tag = (node, n) => node.getElementsByTagNameNS('*', n)[0]?.textContent;

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
      // ListObjectsV2 caps at 1000 keys. A trip album crosses that easily, and
      // skipping this loop truncates the gallery silently.
      token = xml.getElementsByTagNameNS('*', 'NextContinuationToken')[0]?.textContent;
    } while (token);

    return out.filter((e) => e.name);   // drop the prefix's own "directory" key
  }

  async function put(path, blob, type) {
    const res = await aws.fetch(url(path), {
      method: 'PUT',
      body: blob,
      headers: type ? { 'Content-Type': type } : {},
    });
    if (!res.ok) throw await s3Error(res, `upload ${path}`);
  }

  async function get(path) {
    const res = await aws.fetch(url(path));
    if (!res.ok) throw await s3Error(res, `fetch ${path}`);
    return res.blob();
  }

  async function remove(path) {
    const res = await aws.fetch(url(path), { method: 'DELETE' });
    // S3 returns 204 for a delete, and also for a key that was never there.
    if (!res.ok && res.status !== 404) throw await s3Error(res, `delete ${path}`);
  }

  /** JSON convenience. A missing object is `null`, not an error. */
  async function getJSON(path) {
    try {
      return JSON.parse(await (await get(path)).text());
    } catch (e) {
      if (e.status === 404 || e.code === 'NoSuchKey') return null;
      if (e instanceof SyntaxError) return null;   // corrupt file: ignore it
      throw e;
    }
  }

  const putJSON = (path, obj) =>
    put(path, new Blob([JSON.stringify(obj)], { type: 'application/json' }),
        'application/json');

  async function urlFor(path, seconds = 86400) {
    const signed = await aws.sign(`${url(path)}?X-Amz-Expires=${seconds}`, {
      method: 'GET', aws: { signQuery: true },
    });
    return signed.url;
  }

  return { list, get, put, remove, getJSON, putJSON, urlFor };
}
