// @vitest-environment node
/**
 * Listing images: upload, delivery, and the base64 -> R2 backfill.
 *
 * The theme running through every group below is MIXED STATE. From the first
 * deploy until the last backfill batch, one listing can hold a legacy inline
 * `data:` URL and an `/images/<key>` path in the same array, so the tests are
 * written against rows that are half-migrated rather than rows that are neatly
 * one form or the other.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeSupabase, FakeSupabase } from './helpers/fake-supabase';
import {
  createFakeR2,
  FakeR2Bucket,
  GIF_BYTES,
  JPEG_BYTES,
  JPEG_DATA_URL,
  PNG_BYTES,
  PNG_DATA_URL,
  TEXT_BYTES,
  WEBP_BYTES,
  dataUrl,
} from './helpers/fake-r2';

const mocks = vi.hoisted(() => ({ client: null as any }));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => mocks.client,
}));

import worker from '../../workers/index';
import {
  estimateDataUrlBytes,
  IMAGE_BACKFILL_UNAVAILABLE_MESSAGE,
  IMAGE_PATH_PATTERN,
  IMAGE_STORAGE_UNAVAILABLE_MESSAGE,
  isStrictNewDataImageUrl,
  MAX_IMAGE_BYTES,
  MAX_INLINE_IMAGE_BYTES,
  buildAuctionMetaTags,
  injectAuctionMeta,
  migrateAuctionImages,
  sniffImageMime,
  validateImageUpload,
} from '../../workers/shared';

const SELLER = { id: 'usr_seller', name: 'Seller', username: 'seller', token: 'tok_seller', role: 'member' };
const ADMIN = { id: 'usr_admin', name: 'Admin', username: 'admin', token: 'tok_admin', role: 'admin' };

const NOW = Date.now();
const FUTURE = NOW + 3_600_000;

/** A real-looking R2 path, matching what `POST /api/images` hands back. */
const R2_PATH_A = '/images/11111111-2222-4333-8444-555555555555.png';
const R2_PATH_B = '/images/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jpg';

let bucket: FakeR2Bucket;

function env(overrides: Record<string, any> = {}) {
  return {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SECRET_KEY: 'test-secret',
    IMAGES: bucket,
    ...overrides,
  };
}

function auctionRow(overrides: Record<string, any> = {}) {
  const imageUrls = overrides.image_urls ?? [PNG_DATA_URL];

  return {
    id: 'auc_01',
    title: 'Vintage lamp',
    description: 'A lamp',
    phone_number: '0100000000',
    price: 100,
    seller_id: SELLER.id,
    seller_name: SELLER.name,
    status: 'active',
    category: 'General',
    image_url: imageUrls[0],
    image_count: imageUrls.length,
    created_at: NOW - 1000,
    expires_at: FUTURE,
    sold_at: null,
    ...overrides,
    image_urls: imageUrls,
  };
}

function seed(auctions: Record<string, any>[], options: any = {}): FakeSupabase {
  const db = createFakeSupabase({ users: [SELLER, ADMIN], auctions }, options);
  mocks.client = db;
  return db;
}

async function upload(
  bytes: Uint8Array,
  contentType: string | null,
  options: { token?: string; env?: any } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (contentType !== null) {
    headers['content-type'] = contentType;
  }
  if (options.token !== undefined) {
    headers.authorization = `Bearer ${options.token}`;
  }

  return worker.fetch(
    new Request('https://msa-auction.test/api/images', { method: 'POST', headers, body: bytes }),
    options.env ?? env(),
  );
}

beforeEach(() => {
  bucket = createFakeR2();
});

/* ========================================================================== */
/* 1. POST /api/images                                                        */
/* ========================================================================== */

describe('POST /api/images', () => {
  it('stores a PNG and returns an unguessable key plus its path', async () => {
    seed([]);

    const response = await upload(PNG_BYTES, 'image/png', { token: SELLER.token });
    const body = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(body.url).toBe(`/images/${body.key}`);
    expect(body.url).toMatch(IMAGE_PATH_PATTERN);
    expect(body.key).toMatch(/^[0-9a-f-]{36}\.png$/);

    // The bytes actually landed, tagged with the type the serve route echoes.
    expect(bucket.bytesAt(body.key)).toEqual(PNG_BYTES);
    expect(bucket.objects.get(body.key)!.httpMetadata.contentType).toBe('image/png');
  });

  it('requires authentication', async () => {
    seed([]);

    const response = await upload(PNG_BYTES, 'image/png');
    const body = (await response.json()) as any;

    expect(response.status).toBe(401);
    expect(body.code).toBe('UNAUTHORIZED');
    expect(bucket.size).toBe(0);
  });

  it('rejects a content type that is not an accepted image type', async () => {
    seed([]);

    for (const type of ['application/pdf', 'text/html', 'image/svg+xml', 'application/octet-stream']) {
      const response = await upload(PNG_BYTES, type, { token: SELLER.token });
      const body = (await response.json()) as any;

      expect(response.status).toBe(400);
      expect(body.code).toBe('UNSUPPORTED_IMAGE_TYPE');
    }

    // A missing Content-Type is refused the same way.
    const bare = await upload(PNG_BYTES, null, { token: SELLER.token });
    expect(bare.status).toBe(400);
    expect(((await bare.json()) as any).code).toBe('UNSUPPORTED_IMAGE_TYPE');

    expect(bucket.size).toBe(0);
  });

  it('rejects bytes that do not match the declared content type', async () => {
    seed([]);

    // The declared type is allowed; the bytes are something else entirely.
    // This is the case that matters: the object would be served back from our
    // own origin under a type it does not have.
    const disguised = await upload(TEXT_BYTES, 'image/png', { token: SELLER.token });
    expect(disguised.status).toBe(400);
    expect(((await disguised.json()) as any).code).toBe('UNSUPPORTED_IMAGE_TYPE');

    // Both sides are real image types, but they disagree with each other.
    const swapped = await upload(JPEG_BYTES, 'image/png', { token: SELLER.token });
    expect(swapped.status).toBe(400);
    expect(((await swapped.json()) as any).code).toBe('UNSUPPORTED_IMAGE_TYPE');

    expect(bucket.size).toBe(0);
  });

  it('accepts each supported type when the bytes agree', async () => {
    seed([]);

    const cases: [Uint8Array, string, string][] = [
      [PNG_BYTES, 'image/png', 'png'],
      [JPEG_BYTES, 'image/jpeg', 'jpg'],
      [GIF_BYTES, 'image/gif', 'gif'],
      [WEBP_BYTES, 'image/webp', 'webp'],
    ];

    for (const [bytes, type, extension] of cases) {
      const response = await upload(bytes, type, { token: SELLER.token });
      const body = (await response.json()) as any;

      expect(response.status).toBe(200);
      expect(body.key.endsWith(`.${extension}`)).toBe(true);
    }

    expect(bucket.size).toBe(4);
  });

  it('rejects a body over 5 MB', async () => {
    seed([]);

    const oversized = new Uint8Array(MAX_IMAGE_BYTES + 1);
    oversized.set(PNG_BYTES, 0);

    const response = await upload(oversized, 'image/png', { token: SELLER.token });
    const body = (await response.json()) as any;

    expect(response.status).toBe(413);
    expect(body.code).toBe('IMAGE_TOO_LARGE');
    expect(bucket.size).toBe(0);
  });

  it('enforces the size limit on the decoded bytes, not only the header', () => {
    // The route rejects an oversized Content-Length before reading the body,
    // but that header is a claim. This is the check that actually binds.
    const oversized = new Uint8Array(MAX_IMAGE_BYTES + 1);
    oversized.set(PNG_BYTES, 0);

    const result = validateImageUpload('image/png', oversized);

    expect(result.ok).toBe(false);
    expect((result as any).code).toBe('IMAGE_TOO_LARGE');
    expect((result as any).status).toBe(413);
  });

  it('does not derive the key from anything the caller supplied', async () => {
    seed([]);

    const first = (await (await upload(PNG_BYTES, 'image/png', { token: SELLER.token })).json()) as any;
    const second = (await (await upload(PNG_BYTES, 'image/png', { token: SELLER.token })).json()) as any;

    // Identical bytes, identical type, different keys.
    expect(first.key).not.toBe(second.key);
  });

  it('reports 503 IMAGE_STORAGE_UNAVAILABLE when no bucket is bound', async () => {
    seed([]);

    const response = await upload(PNG_BYTES, 'image/png', {
      token: SELLER.token,
      env: env({ IMAGES: undefined }),
    });
    const body = (await response.json()) as any;

    // This exact pair is a contract with the client, which falls back to
    // inlining the image as a base64 data URL when it sees this code. Changing
    // either half silently breaks listing creation while R2 is off.
    expect(response.status).toBe(503);
    expect(body.code).toBe('IMAGE_STORAGE_UNAVAILABLE');
    // `makeError` suffixes the code onto the message, hence toContain.
    expect(body.error).toContain(IMAGE_STORAGE_UNAVAILABLE_MESSAGE);
    expect(body.error).toMatch(/object storage is not configured/i);
  });
});

describe('sniffImageMime', () => {
  it('identifies each accepted format and refuses anything else', () => {
    expect(sniffImageMime(PNG_BYTES)).toBe('image/png');
    expect(sniffImageMime(JPEG_BYTES)).toBe('image/jpeg');
    expect(sniffImageMime(GIF_BYTES)).toBe('image/gif');
    expect(sniffImageMime(WEBP_BYTES)).toBe('image/webp');

    expect(sniffImageMime(TEXT_BYTES)).toBeNull();
    // Too short to carry a signature at all.
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
  });
});

/* ========================================================================== */
/* 2. GET /images/:key                                                        */
/* ========================================================================== */

describe('GET /images/:key', () => {
  async function serve(path: string, overrides: Record<string, any> = {}) {
    return worker.fetch(new Request(`https://msa-auction.test${path}`), env(overrides));
  }

  it('streams the object with its stored type and an immutable cache header', async () => {
    seed([]);
    const { key } = (await (await upload(JPEG_BYTES, 'image/jpeg', { token: SELLER.token })).json()) as any;

    const response = await serve(`/images/${key}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    // A user-supplied byte stream served from our own origin must not be
    // re-typed by the browser.
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');

    expect(new Uint8Array(await response.arrayBuffer())).toEqual(JPEG_BYTES);
  });

  it('404s a key that is not in the bucket', async () => {
    seed([]);

    const response = await serve('/images/99999999-8888-4777-8666-555555555555.png');
    const body = (await response.json()) as any;

    expect(response.status).toBe(404);
    expect(body.code).toBe('IMAGE_NOT_FOUND');
  });

  it('is matched before the static-asset branch', async () => {
    seed([]);
    const { key } = (await (await upload(PNG_BYTES, 'image/png', { token: SELLER.token })).json()) as any;

    // ASSETS would otherwise claim every non-/api/ path and answer with the SPA
    // shell. If this ever regresses, the body below becomes HTML.
    const assets = { fetch: async () => new Response('SPA SHELL', { status: 200 }) };
    const response = await worker.fetch(
      new Request(`https://msa-auction.test/images/${key}`),
      env({ ASSETS: assets }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(await response.text()).not.toContain('SPA SHELL');
  });

  it('refuses a malformed key without consulting the bucket', async () => {
    seed([]);
    const assets = { fetch: async () => new Response('SPA SHELL', { status: 200 }) };

    // Traversal, a nested path and a wrong extension are all rejected by the
    // key pattern, so they fall through to the SPA shell rather than reaching
    // R2 with an attacker-chosen key.
    for (const path of [
      '/images/../secret',
      '/images/nested/key.png',
      '/images/11111111-2222-4333-8444-555555555555.exe',
      '/images/not-a-uuid.png',
    ]) {
      const response = await worker.fetch(new Request(`https://msa-auction.test${path}`), env({ ASSETS: assets }));
      expect(await response.text()).toBe('SPA SHELL');
    }
  });
});

/* ========================================================================== */
/* 3. Mixed-state reads                                                       */
/* ========================================================================== */

describe('reading a listing whose images are half migrated', () => {
  const MIXED = [R2_PATH_A, PNG_DATA_URL, R2_PATH_B];

  it('returns both forms, in order, from the images endpoint', async () => {
    seed([auctionRow({ image_urls: MIXED })]);

    const response = await worker.fetch(new Request('https://msa-auction.test/api/auctions/auc_01/images'), env());
    const body = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(body.imageUrls).toEqual(MIXED);
  });

  it('reports the right imageCount from the single-auction endpoint, which carries no image data at all', async () => {
    seed([auctionRow({ image_urls: MIXED, image_count: MIXED.length })]);

    const response = await worker.fetch(new Request('https://msa-auction.test/api/auctions/auc_01'), env());
    const body = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(body.auction).not.toHaveProperty('imageUrls');
    expect(body.auction).not.toHaveProperty('imageUrl');
    expect(body.auction.imageCount).toBe(MIXED.length);

    // Both forms are still available, in order, from the dedicated images route.
    const images = await worker.fetch(new Request('https://msa-auction.test/api/auctions/auc_01/images'), env());
    expect((await images.json() as any).imageUrls).toEqual(MIXED);
  });

  it('lets a seller edit a listing that still holds a legacy image', async () => {
    const db = seed([auctionRow({ image_urls: MIXED })]);

    const response = await worker.fetch(
      new Request('https://msa-auction.test/api/auctions/auc_01', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${SELLER.token}` },
        body: JSON.stringify({ title: 'Renamed lamp' }),
      }),
      env(),
    );

    // The untouched image array is round-tripped through the validator by
    // `mergeAuctionEdit`. If the validator rejected legacy entries, every
    // half-migrated listing would become uneditable.
    expect(response.status).toBe(200);
    expect(db.rows('auctions')[0].title).toBe('Renamed lamp');
    expect(db.rows('auctions')[0].image_urls).toEqual(MIXED);
  });
});

/* ========================================================================== */
/* 4. validateAuctionInput                                                    */
/* ========================================================================== */

describe('listing creation image validation', () => {
  async function create(imageUrls: any[]) {
    return worker.fetch(
      new Request('https://msa-auction.test/api/auctions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${SELLER.token}` },
        body: JSON.stringify({
          title: 'A thing',
          description: 'Some description',
          phoneNumber: '0100000000',
          price: 10,
          imageUrls,
        }),
      }),
      env(),
    );
  }

  it('accepts R2 paths, legacy data URLs, and a mixture of the two', async () => {
    for (const images of [[R2_PATH_A], [PNG_DATA_URL], [R2_PATH_A, PNG_DATA_URL, R2_PATH_B]]) {
      seed([]);
      const response = await create(images);
      expect(response.status).toBe(201);
    }
  });

  it('rejects an external URL', async () => {
    // Accepting one would let a listing point this site's own pages at any
    // third-party host, and hand that host a log of everyone who viewed it.
    for (const hostile of [
      'https://evil.example/tracker.png',
      'http://evil.example/tracker.png',
      '//evil.example/tracker.png',
      '/images/../../etc/passwd',
      'javascript:alert(1)',
      '/images/not-a-uuid.png',
    ]) {
      seed([]);
      const response = await create([hostile]);
      const body = (await response.json()) as any;

      expect(response.status).toBe(400);
      expect(body.code).toBe('INVALID_IMAGE_URL');
    }
  });

  it('rejects an external URL hidden behind a valid one', async () => {
    seed([]);

    const response = await create([R2_PATH_A, 'https://evil.example/tracker.png']);

    expect(response.status).toBe(400);
    expect(((await response.json()) as any).code).toBe('INVALID_IMAGE_URL');
  });
});

/* ========================================================================== */
/* 4b. Fix 1b: server-side size cap on a NEW inline image                     */
/* ========================================================================== */

describe('the 300KB cap on a new inline data: image', () => {
  /** A `data:` URL whose decoded payload is exactly `sizeBytes` long. */
  function dataUrlOfSize(sizeBytes: number): string {
    return `data:image/jpeg;base64,${Buffer.alloc(sizeBytes, 1).toString('base64')}`;
  }

  async function create(imageUrls: any[]) {
    return worker.fetch(
      new Request('https://msa-auction.test/api/auctions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${SELLER.token}` },
        body: JSON.stringify({
          title: 'A thing',
          description: 'Some description',
          phoneNumber: '0100000000',
          price: 10,
          imageUrls,
        }),
      }),
      env(),
    );
  }

  it('rejects a brand new listing whose inline image decodes to over 300KB', async () => {
    seed([]);

    const response = await create([dataUrlOfSize(300 * 1024 + 1)]);
    const body = (await response.json()) as any;

    expect(response.status).toBe(400);
    expect(body.code).toBe('IMAGE_TOO_LARGE');
  });

  it('accepts a new listing whose inline image decodes to exactly 300KB', async () => {
    seed([]);

    const response = await create([dataUrlOfSize(300 * 1024)]);

    expect(response.status).toBe(201);
  });

  it('does not apply the cap to an /images/<key> path, only to data: URLs', async () => {
    seed([]);

    const response = await create([R2_PATH_A]);

    expect(response.status).toBe(201);
  });

  it('rejects an edit that swaps in a new oversized inline image', async () => {
    seed([auctionRow({ image_urls: [PNG_DATA_URL] })]);
    const oversized = dataUrlOfSize(300 * 1024 + 1);

    const response = await worker.fetch(
      new Request('https://msa-auction.test/api/auctions/auc_01', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${SELLER.token}` },
        body: JSON.stringify({ imageUrls: [oversized] }),
      }),
      env(),
    );
    const body = (await response.json()) as any;

    expect(response.status).toBe(400);
    expect(body.code).toBe('IMAGE_TOO_LARGE');
  });

  it('accepts an edit that carries over an existing oversized image unchanged', async () => {
    // This row predates the 300KB cap - its stored image is already over it.
    const oversizedExisting = dataUrlOfSize(300 * 1024 + 1);
    const db = seed([auctionRow({ image_urls: [oversizedExisting] })]);

    const response = await worker.fetch(
      new Request('https://msa-auction.test/api/auctions/auc_01', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${SELLER.token}` },
        // The image is not mentioned in the patch, so mergeAuctionEdit carries the stored
        // (oversized) array through unchanged - only the title actually changes.
        body: JSON.stringify({ title: 'Renamed lamp' }),
      }),
      env(),
    );

    expect(response.status).toBe(200);
    expect(db.rows('auctions')[0].image_urls).toEqual([oversizedExisting]);
    expect(db.rows('auctions')[0].title).toBe('Renamed lamp');
  });
});

/* ========================================================================== */
/* 4b-2. V1 revision: the size-cap bypass via a malformed data: URL           */
/* ========================================================================== */

/**
 * `estimateDataUrlBytes` used to return 0 for any `data:image/...` value that wasn't in the
 * EXACT `data:<type>;base64,<payload>` shape - an extra `;name=`/`;charset=` parameter, or no
 * `;base64,` marker at all, made its regex fail to match. Since `isDataImageUrl` (the whitelist
 * check) accepts anything starting `data:image/`, all three of those forms sailed through
 * `validateAuctionInput` as a "0 byte" image, no matter how large the payload actually was. This
 * section pins the fix: `isStrictNewDataImageUrl` rejects all three outright for a NEW image, and
 * `estimateDataUrlBytes` itself no longer returns 0 for any of them either.
 */
describe('the size-cap bypass via a malformed data: URL (fixed)', () => {
  const THREE_MB_BASE64 = Buffer.alloc(3 * 1024 * 1024, 1).toString('base64');
  const SMALL_BASE64 = Buffer.alloc(1024, 1).toString('base64');

  const MALFORMED_FORMS = [
    { label: 'an extra ;name= parameter', dataUrl: (base64: string) => `data:image/jpeg;name=x.jpg;base64,${base64}` },
    { label: 'an extra ;charset= parameter', dataUrl: (base64: string) => `data:image/jpeg;charset=utf-8;base64,${base64}` },
    // Not base64 at all - no `;base64,` marker - which `estimateDataUrlBytes`'s old regex also
    // failed to match, the same way it failed on the two forms above.
    { label: 'an unencoded (non-base64) data URL', dataUrl: (payload: string) => `data:image/svg+xml,${payload}` },
  ];

  async function create(imageUrls: any[]) {
    return worker.fetch(
      new Request('https://msa-auction.test/api/auctions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${SELLER.token}` },
        body: JSON.stringify({
          title: 'A thing',
          description: 'Some description',
          phoneNumber: '0100000000',
          price: 10,
          imageUrls,
        }),
      }),
      env(),
    );
  }

  it('accepts the plain, well-formed form when small', async () => {
    seed([]);

    const response = await create([`data:image/jpeg;base64,${SMALL_BASE64}`]);

    expect(response.status).toBe(201);
  });

  it('rejects the plain, well-formed form when over 300KB (unchanged behaviour)', async () => {
    seed([]);

    const response = await create([`data:image/jpeg;base64,${THREE_MB_BASE64}`]);
    const body = (await response.json()) as any;

    expect(response.status).toBe(400);
    expect(body.code).toBe('IMAGE_TOO_LARGE');
  });

  for (const form of MALFORMED_FORMS) {
    it(`rejects ${form.label}, even a small payload`, async () => {
      seed([]);

      const response = await create([form.dataUrl(SMALL_BASE64)]);
      const body = (await response.json()) as any;

      expect(response.status).toBe(400);
      expect(body.code).toBe('INVALID_IMAGE_URL');
    });

    it(`rejects ${form.label} at 3MB (the bypass this closes)`, async () => {
      seed([]);

      const response = await create([form.dataUrl(THREE_MB_BASE64)]);
      const body = (await response.json()) as any;

      expect(response.status).toBe(400);
      // Whether this comes back as INVALID_IMAGE_URL (shape rejected outright) or
      // IMAGE_TOO_LARGE (shape accepted but sized as huge) is an implementation detail; what
      // matters, and what the old code got wrong, is that it must NOT be a 201.
      expect(['INVALID_IMAGE_URL', 'IMAGE_TOO_LARGE']).toContain(body.code);
    });
  }
});

describe('isStrictNewDataImageUrl', () => {
  it('accepts the exact shape compressImageToBlob emits', () => {
    expect(isStrictNewDataImageUrl('data:image/jpeg;base64,QUFB')).toBe(true);
    expect(isStrictNewDataImageUrl('data:image/png;base64,QUFB')).toBe(true);
    expect(isStrictNewDataImageUrl('data:image/webp;base64,QUFB')).toBe(true);
    expect(isStrictNewDataImageUrl('data:image/gif;base64,QUFB')).toBe(true);
  });

  it('rejects an extra ;name= or ;charset= parameter', () => {
    expect(isStrictNewDataImageUrl('data:image/jpeg;name=x.jpg;base64,QUFB')).toBe(false);
    expect(isStrictNewDataImageUrl('data:image/jpeg;charset=utf-8;base64,QUFB')).toBe(false);
  });

  it('rejects a data URL with no ;base64, marker at all', () => {
    expect(isStrictNewDataImageUrl('data:image/svg+xml,<svg></svg>')).toBe(false);
  });

  it('rejects an unsupported subtype even in the strict shape', () => {
    expect(isStrictNewDataImageUrl('data:image/svg+xml;base64,QUFB')).toBe(false);
  });

  it('rejects a non-string and a non-data-url', () => {
    expect(isStrictNewDataImageUrl(undefined)).toBe(false);
    expect(isStrictNewDataImageUrl('/images/11111111-2222-4333-8444-555555555555.png')).toBe(false);
  });
});

describe('estimateDataUrlBytes fails safe on a malformed data:image/ value', () => {
  it('never returns 0 for a value that starts data:image/ but is not the exact <type>;base64, shape', () => {
    const malformed = [
      `data:image/jpeg;name=x.jpg;base64,${Buffer.alloc(1024, 1).toString('base64')}`,
      `data:image/jpeg;charset=utf-8;base64,${Buffer.alloc(1024, 1).toString('base64')}`,
      'data:image/svg+xml,<svg width="1" height="1"></svg>',
    ];

    for (const value of malformed) {
      expect(estimateDataUrlBytes(value)).toBeGreaterThan(0);
    }
  });

  it('still measures the well-formed shape correctly', () => {
    const base64 = Buffer.alloc(1024, 1).toString('base64');
    expect(estimateDataUrlBytes(`data:image/jpeg;base64,${base64}`)).toBe(1024);
  });

  it('returns 0 for a value that is not a data:image/ URL at all', () => {
    expect(estimateDataUrlBytes('/images/11111111-2222-4333-8444-555555555555.png')).toBe(0);
    expect(estimateDataUrlBytes('https://evil.example/tracker.png')).toBe(0);
    expect(estimateDataUrlBytes(undefined)).toBe(0);
  });

  it('the fail-safe estimate for a malformed value is at least the true payload size (never an under-count)', () => {
    const threeMbBase64 = Buffer.alloc(3 * 1024 * 1024, 1).toString('base64');
    const malformed = `data:image/jpeg;name=x.jpg;base64,${threeMbBase64}`;

    expect(estimateDataUrlBytes(malformed)).toBeGreaterThan(MAX_INLINE_IMAGE_BYTES);
  });
});

/* ========================================================================== */
/* 4c. Fix 1c: the image_url mirror column                                    */
/* ========================================================================== */

describe('the image_url mirror column on write', () => {
  it('is left null on create when the first image is a base64 data: URL', async () => {
    const db = seed([]);

    const response = await worker.fetch(
      new Request('https://msa-auction.test/api/auctions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${SELLER.token}` },
        body: JSON.stringify({
          title: 'A thing',
          description: 'Some description',
          phoneNumber: '0100000000',
          price: 10,
          imageUrls: [PNG_DATA_URL],
        }),
      }),
      env(),
    );

    expect(response.status).toBe(201);
    const row = db.rows('auctions')[0];
    expect(row.image_url).toBeNull();
    // The full image is still available from image_urls[0] - nothing reads it from image_url.
    expect(row.image_urls).toEqual([PNG_DATA_URL]);
  });

  it('still writes the /images/<key> path on create, since buildAuctionMetaTags reads image_url alone', async () => {
    const db = seed([]);

    const response = await worker.fetch(
      new Request('https://msa-auction.test/api/auctions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${SELLER.token}` },
        body: JSON.stringify({
          title: 'A thing',
          description: 'Some description',
          phoneNumber: '0100000000',
          price: 10,
          imageUrls: [R2_PATH_A],
        }),
      }),
      env(),
    );

    expect(response.status).toBe(201);
    expect(db.rows('auctions')[0].image_url).toBe(R2_PATH_A);
  });

  it('is set back to null on an edit that replaces an R2 path with a data: URL', async () => {
    const db = seed([auctionRow({ image_urls: [R2_PATH_A], image_url: R2_PATH_A })]);

    const response = await worker.fetch(
      new Request('https://msa-auction.test/api/auctions/auc_01', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${SELLER.token}` },
        body: JSON.stringify({ imageUrls: [PNG_DATA_URL] }),
      }),
      env(),
    );

    expect(response.status).toBe(200);
    expect(db.rows('auctions')[0].image_url).toBeNull();
  });
});

/* ========================================================================== */
/* 5. og:image                                                                */
/* ========================================================================== */

describe('og:image', () => {
  const PAGE_URL = 'https://msa-auction.test/auction/auc_01';

  it('is an absolute https URL when the first image is in R2', () => {
    const meta = buildAuctionMetaTags({ title: 'Lamp', image_url: R2_PATH_A, price: 10 }, PAGE_URL);

    expect(meta.image).toBe(`https://msa-auction.test${R2_PATH_A}`);
    expect(injectAuctionMeta('<head></head>', meta)).toContain(
      `<meta property="og:image" content="https://msa-auction.test${R2_PATH_A}" />`,
    );
  });

  it('falls back to the absolute site logo when the first image is still legacy', () => {
    const meta = buildAuctionMetaTags({ title: 'Lamp', image_url: PNG_DATA_URL, price: 10 }, PAGE_URL);

    // A base64 data URL can never be emitted - every crawler rejects it. But
    // emitting NOTHING would be a regression: the static shell carries a logo
    // og:image today, and injectAuctionMeta strips it. So an un-backfilled
    // listing must still preview as the logo, not as a blank card.
    expect(meta.image).toBe('https://msa-auction.test/MSA_Logo.png');

    const html = injectAuctionMeta('<head></head>', meta);
    expect(html).toContain('<meta property="og:image" content="https://msa-auction.test/MSA_Logo.png" />');
    expect(html).not.toContain('data:image');
  });

  it('resolves from image_urls when the singular column is empty', () => {
    const legacy = buildAuctionMetaTags({ title: 'Lamp', image_urls: [PNG_DATA_URL, R2_PATH_A] }, PAGE_URL);
    expect(legacy.image).toBe('https://msa-auction.test/MSA_Logo.png');

    const migrated = buildAuctionMetaTags({ title: 'Lamp', image_urls: [R2_PATH_B, PNG_DATA_URL] }, PAGE_URL);
    expect(migrated.image).toBe(`https://msa-auction.test${R2_PATH_B}`);
  });

  it('never emits a blank or data-URL preview through the share route', async () => {
    // The end-to-end version of the regression above, through the real route.
    seed([auctionRow({ image_urls: [PNG_DATA_URL] })]);

    const assets = {
      fetch: async () =>
        new Response('<html><head><title>MSA</title></head><body></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    };

    const response = await worker.fetch(
      new Request('https://msa-auction.test/auction/auc_01'),
      env({ ASSETS: assets }),
    );
    const html = await response.text();

    expect(html).toContain('<meta property="og:image" content="https://msa-auction.test/MSA_Logo.png" />');
    expect(html).not.toContain('data:image');
  });

  it('falls back to an absolute site logo when the listing has no image at all', () => {
    const meta = buildAuctionMetaTags({ title: 'Lamp', image_urls: [] }, PAGE_URL);

    expect(meta.image).toBe('https://msa-auction.test/MSA_Logo.png');
  });

  it('serves an absolute og:image through the share route', async () => {
    seed([auctionRow({ image_urls: [R2_PATH_A] })]);

    const assets = {
      fetch: async () =>
        new Response('<html><head><title>MSA</title></head><body></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    };

    const response = await worker.fetch(
      new Request('https://msa-auction.test/auction/auc_01'),
      env({ ASSETS: assets }),
    );
    const html = await response.text();

    expect(html).toContain(`<meta property="og:image" content="https://msa-auction.test${R2_PATH_A}" />`);
  });
});

/* ========================================================================== */
/* 6. POST /api/admin/migrate-images                                          */
/* ========================================================================== */

describe('the base64 -> R2 backfill', () => {
  async function runBatch(limit?: number, overrides: Record<string, any> = {}) {
    const response = await worker.fetch(
      new Request('https://msa-auction.test/api/admin/migrate-images', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN.token}` },
        body: JSON.stringify(limit === undefined ? {} : { limit }),
      }),
      env(overrides),
    );

    return { status: response.status, body: (await response.json()) as any };
  }

  it('is admin only', async () => {
    seed([auctionRow()]);

    const response = await worker.fetch(
      new Request('https://msa-auction.test/api/admin/migrate-images', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${SELLER.token}` },
        body: '{}',
      }),
      env(),
    );

    expect(response.status).toBe(403);
    expect(((await response.json()) as any).code).toBe('NOT_ADMIN');
    expect(bucket.size).toBe(0);
  });

  it('converts a data-URL row and rewrites both image columns', async () => {
    const db = seed([auctionRow({ id: 'auc_01', image_urls: [PNG_DATA_URL, JPEG_DATA_URL] })]);

    const { status, body } = await runBatch();

    expect(status).toBe(200);
    expect(body.migrated).toBe(1);
    expect(body.remaining).toBe(0);
    expect(body.failures).toEqual([]);

    const row = db.rows('auctions')[0];
    expect(row.image_urls).toHaveLength(2);
    for (const entry of row.image_urls) {
      expect(entry).toMatch(IMAGE_PATH_PATTERN);
    }
    // The legacy singular column is kept in step with the array.
    expect(row.image_url).toBe(row.image_urls[0]);

    // Both images reached R2, each under the extension its bytes imply.
    expect(bucket.size).toBe(2);
    expect(row.image_urls[0].endsWith('.png')).toBe(true);
    expect(row.image_urls[1].endsWith('.jpg')).toBe(true);
  });

  it('converts only the legacy entries of a half-migrated row', async () => {
    const db = seed([auctionRow({ id: 'auc_01', image_urls: [R2_PATH_A, PNG_DATA_URL] })]);

    const { body } = await runBatch();

    expect(body.migrated).toBe(1);

    const row = db.rows('auctions')[0];
    // The already-migrated entry is carried through byte for byte, in place.
    expect(row.image_urls[0]).toBe(R2_PATH_A);
    expect(row.image_urls[1]).toMatch(IMAGE_PATH_PATTERN);
    expect(row.image_urls[1]).not.toBe(PNG_DATA_URL);

    // Only the one legacy image was uploaded.
    expect(bucket.size).toBe(1);
  });

  it('is idempotent: a second run uploads nothing and migrates nothing', async () => {
    const db = seed([
      auctionRow({ id: 'auc_01', image_urls: [PNG_DATA_URL] }),
      auctionRow({ id: 'auc_02', image_urls: [JPEG_DATA_URL] }),
    ]);

    const first = await runBatch();
    expect(first.body.migrated).toBe(2);
    expect(first.body.remaining).toBe(0);

    const afterFirst = db.rows('auctions').map((row: any) => row.image_urls);
    const uploadsAfterFirst = bucket.size;

    const second = await runBatch();

    expect(second.body.migrated).toBe(0);
    expect(second.body.remaining).toBe(0);
    expect(second.body.failures).toEqual([]);
    // Nothing re-uploaded, nothing rewritten.
    expect(bucket.size).toBe(uploadsAfterFirst);
    expect(db.rows('auctions').map((row: any) => row.image_urls)).toEqual(afterFirst);
  });

  it('reports a failing row and still migrates the rest of the batch', async () => {
    const db = seed([
      auctionRow({ id: 'auc_01', image_urls: [PNG_DATA_URL] }),
      // Undecodable base64: this row can never be converted.
      auctionRow({ id: 'auc_02', image_urls: ['data:image/png;base64,!!!!!not base64!!!!!'] }),
      auctionRow({ id: 'auc_03', image_urls: [JPEG_DATA_URL] }),
    ]);

    const { body } = await runBatch();

    // The broken row did not abort the batch.
    expect(body.migrated).toBe(2);
    expect(body.failures).toHaveLength(1);
    expect(body.failures[0].auctionId).toBe('auc_02');
    expect(typeof body.failures[0].error).toBe('string');
    expect(body.failures[0].error.length).toBeGreaterThan(0);

    const rows = db.rows('auctions');
    expect(rows[0].image_urls[0]).toMatch(IMAGE_PATH_PATTERN);
    // The failure is left exactly as it was, not half-written.
    expect(rows[1].image_urls[0]).toBe('data:image/png;base64,!!!!!not base64!!!!!');
    expect(rows[2].image_urls[0]).toMatch(IMAGE_PATH_PATTERN);

    // It is still counted as outstanding, which is why the owner's loop has to
    // stop on `migrated === 0` rather than on `remaining === 0`.
    expect(body.remaining).toBe(1);
  });

  it('does not retry the same failing row within one batch', async () => {
    const db = seed([auctionRow({ id: 'auc_01', image_urls: ['data:image/png;base64,!!!!!not base64!!!!!'] })]);

    const { body } = await runBatch(50);

    expect(body.migrated).toBe(0);
    expect(body.failures).toHaveLength(1);
    // One attempt, one report - not one per unit of the limit.
    expect(db.rows('auctions')).toHaveLength(1);
  });

  it('honours the limit, defaults to 10 and caps at 50', async () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      auctionRow({ id: `auc_${String(index).padStart(2, '0')}`, image_urls: [PNG_DATA_URL] }),
    );

    seed(many);
    const explicit = await runBatch(3);
    expect(explicit.body.migrated).toBe(3);
    expect(explicit.body.remaining).toBe(9);

    seed(many);
    bucket = createFakeR2();
    const defaulted = await runBatch();
    expect(defaulted.body.migrated).toBe(10);
    expect(defaulted.body.remaining).toBe(2);

    seed(many);
    bucket = createFakeR2();
    // Over the cap, so it is clamped rather than honoured.
    const capped = await runBatch(5000);
    expect(capped.body.migrated).toBe(12);
  });

  it('resumes across calls until nothing is left', async () => {
    const db = seed(
      Array.from({ length: 7 }, (_, index) =>
        auctionRow({ id: `auc_${String(index).padStart(2, '0')}`, image_urls: [PNG_DATA_URL] }),
      ),
    );

    let guard = 0;
    let last = await runBatch(2);
    while (last.body.migrated > 0 && guard < 20) {
      last = await runBatch(2);
      guard += 1;
    }

    expect(last.body.remaining).toBe(0);
    for (const row of db.rows('auctions')) {
      expect(row.image_urls[0]).toMatch(IMAGE_PATH_PATTERN);
    }
  });

  it('does not overwrite a listing that was edited mid-migration', async () => {
    const REPLACED = [dataUrl('image/gif', GIF_BYTES)];

    const db = seed([auctionRow({ id: 'auc_01', image_urls: [PNG_DATA_URL, JPEG_DATA_URL] })], {
      // A seller lands an edit between the read and the write, dropping from
      // two images to one.
      beforeUpdate: ({ table }: any) => {
        if (table !== 'auctions') return;
        const row = db.rows('auctions')[0];
        if (row.image_count === 2) {
          row.image_urls = REPLACED;
          row.image_url = REPLACED[0];
          row.image_count = 1;
        }
      },
    });

    const { body } = await runBatch();

    // The guard caught it: nothing migrated, and the seller's edit survived.
    expect(body.migrated).toBe(0);
    expect(body.failures).toHaveLength(1);
    expect(body.failures[0].auctionId).toBe('auc_01');

    const row = db.rows('auctions')[0];
    expect(row.image_urls).toEqual(REPLACED);
  });

  it('returns 503 naming the missing binding when no bucket is bound', async () => {
    seed([auctionRow()]);

    const { status, body } = await runBatch(undefined, { IMAGES: undefined });

    // A 503 with an explanation, not a crash on `undefined.put`, and not a
    // generic 500 that leaves an admin guessing what to fix.
    expect(status).toBe(503);
    expect(body.code).toBe('IMAGE_STORAGE_UNAVAILABLE');
    expect(body.error).toContain(IMAGE_BACKFILL_UNAVAILABLE_MESSAGE);
    expect(body.error).toContain('IMAGES');
    expect(body.error).toContain('r2_buckets');
  });

  it('leaves a row alone when it holds no legacy image', async () => {
    const db = seed([auctionRow({ id: 'auc_01', image_urls: [R2_PATH_A, R2_PATH_B] })]);

    const { body } = await runBatch();

    expect(body.migrated).toBe(0);
    expect(body.remaining).toBe(0);
    expect(bucket.size).toBe(0);
    expect(db.rows('auctions')[0].image_urls).toEqual([R2_PATH_A, R2_PATH_B]);
  });

  it('finds a legacy entry hiding behind an already-migrated first image', async () => {
    // This row is invisible to the cheap `image_url like 'data:%'` filter, so
    // it is only reached by the second pass.
    const db = seed([auctionRow({ id: 'auc_01', image_urls: [R2_PATH_A, JPEG_DATA_URL] })]);

    const { body } = await runBatch();

    expect(body.migrated).toBe(1);
    expect(body.remaining).toBe(0);
    expect(db.rows('auctions')[0].image_urls[1]).toMatch(IMAGE_PATH_PATTERN);
  });
});

/* ========================================================================== */
/* 6b. Telling "nothing left to do" apart from "the scan found nothing"        */
/* ========================================================================== */

describe('the backfill when the indexed like filter matches nothing', () => {
  /**
   * The loop stops on `migrated === 0`. If the `image_url like 'data:%'` filter
   * ever matched nothing against a database that really does hold inline
   * images, that would look exactly like success from the outside. These two
   * tests pin the two things that stop it being mistaken for success.
   */

  it('still migrates, because the full scan catches what the filter missed', async () => {
    const db = seed(
      [
        auctionRow({ id: 'auc_01', image_urls: [PNG_DATA_URL] }),
        auctionRow({ id: 'auc_02', image_urls: [JPEG_DATA_URL] }),
      ],
      { likeMatchesNothing: true },
    );

    const result = await migrateAuctionImages(db as any, bucket, { limit: 10 });

    // The work still gets done - the fallback scan does not depend on `like`.
    expect(result.migrated).toBe(2);
    expect(result.remaining).toBe(0);
    for (const row of db.rows('auctions')) {
      expect(row.image_urls[0]).toMatch(IMAGE_PATH_PATTERN);
    }
  });

  it('reports a scan that makes the broken filter visible', async () => {
    const db = seed([auctionRow({ id: 'auc_01', image_urls: [PNG_DATA_URL] })], { likeMatchesNothing: true });

    const result = await migrateAuctionImages(db as any, bucket, { limit: 10 });

    // The tell: the indexed filter matched nothing, while the control count -
    // which does not go through `like` - says there are listings with images.
    expect(result.scan.fastPathMatched).toBe(0);
    expect(result.scan.listingsWithImages).toBe(1);
    expect(result.scan.fallbackScanned).toBe(1);
  });

  it('reports a healthy scan on the normal path', async () => {
    const db = seed([
      auctionRow({ id: 'auc_01', image_urls: [PNG_DATA_URL] }),
      auctionRow({ id: 'auc_02', image_urls: [JPEG_DATA_URL] }),
    ]);

    const result = await migrateAuctionImages(db as any, bucket, { limit: 10 });

    // The indexed filter found and converted both rows. The fallback sweep
    // still runs afterwards to verify nothing is hiding behind a migrated first
    // image, so a non-zero `fallbackScanned` here is expected - what marks this
    // as healthy is that `fastPathMatched` is non-zero at all.
    expect(result.scan.fastPathMatched).toBe(2);
    expect(result.scan.listingsWithImages).toBe(2);
    expect(result.migrated).toBe(2);
  });

  it('reports listingsWithImages even when there is genuinely nothing to do', async () => {
    // The real "finished" state: a control count that is NOT zero, alongside
    // migrated 0. That is what distinguishes it from an empty database.
    const db = seed([auctionRow({ id: 'auc_01', image_urls: [R2_PATH_A] })]);

    const result = await migrateAuctionImages(db as any, bucket, { limit: 10 });

    expect(result.migrated).toBe(0);
    expect(result.remaining).toBe(0);
    expect(result.scan.listingsWithImages).toBe(1);
  });
});

/* ========================================================================== */
/* 7. The backfill against a bucket that rejects writes                       */
/* ========================================================================== */

describe('the backfill when R2 itself fails', () => {
  it('records the row and leaves the database untouched', async () => {
    const db = seed([auctionRow({ id: 'auc_01', image_urls: [PNG_DATA_URL] })]);
    const failing = createFakeR2({ failPut: () => new Error('R2 unavailable') });

    const result = await migrateAuctionImages(db as any, failing, { limit: 5 });

    expect(result.migrated).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].error).toContain('R2 unavailable');
    // Still a data URL - a failed upload never leaves a dangling path behind.
    expect(db.rows('auctions')[0].image_urls).toEqual([PNG_DATA_URL]);
    expect(result.remaining).toBe(1);
  });
});

/* ========================================================================== */
/* 8. THE SHIPPING CONFIGURATION: no R2 bucket at all                         */
/* ========================================================================== */

/**
 * This is the state the site actually deploys in. The `[[r2_buckets]]` block in
 * wrangler.toml is commented out, because enabling R2 on a Cloudflare account
 * requires a payment method and this is a university society's project. So
 * `env.IMAGES` is genuinely `undefined` in production.
 *
 * Every group above proves the R2 implementation still works when a bucket IS
 * bound - that code is kept, not deleted, so switching it on later is a
 * wrangler.toml edit and nothing else. This group proves the OTHER state: that
 * with no binding the site is fully usable, nothing throws on `undefined`, and
 * a student can still create a listing with photos.
 */
describe('with no R2 binding (the deployed configuration)', () => {
  /** Exactly what the Worker receives in production today. */
  function noBucketEnv(overrides: Record<string, any> = {}) {
    return { ...env(), IMAGES: undefined, ...overrides };
  }

  const SPA = { fetch: async () => new Response('SPA SHELL', { status: 200 }) };

  it('404s GET /images/:key rather than erroring on the absent binding', async () => {
    seed([]);

    const response = await worker.fetch(
      new Request('https://msa-auction.test/images/11111111-2222-4333-8444-555555555555.png'),
      noBucketEnv(),
    );
    const body = (await response.json()) as any;

    // No binding means no bucket means no key was ever minted, so nothing can
    // exist at this path. 404 is the honest answer and is what <img> and every
    // cache in between already handle.
    expect(response.status).toBe(404);
    expect(body.code).toBe('IMAGE_NOT_FOUND');
  });

  it('still claims /images/ ahead of the SPA shell when the binding is absent', async () => {
    seed([]);

    // A regression here would answer an image request with HTML, which is worse
    // than a 404: the browser renders a broken image either way, but the
    // response is 200 and nothing looks wrong in the logs.
    const response = await worker.fetch(
      new Request('https://msa-auction.test/images/11111111-2222-4333-8444-555555555555.png'),
      noBucketEnv({ ASSETS: SPA }),
    );

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('SPA SHELL');
  });

  it('lets a student create a listing with inline base64 images', async () => {
    // The whole point. With R2 off the client uploads nothing and submits data
    // URLs, exactly as it did before R2 existed. If this fails, nobody can list
    // anything at all.
    const db = seed([]);

    const response = await worker.fetch(
      new Request('https://msa-auction.test/api/auctions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${SELLER.token}` },
        body: JSON.stringify({
          title: 'A thing',
          description: 'Some description',
          phoneNumber: '0100000000',
          price: 10,
          imageUrls: [PNG_DATA_URL, JPEG_DATA_URL],
        }),
      }),
      noBucketEnv(),
    );

    expect(response.status).toBe(201);
    expect(db.rows('auctions')[0].image_urls).toEqual([PNG_DATA_URL, JPEG_DATA_URL]);
  });

  it('still accepts an /images/ path with no binding bound', async () => {
    // Rows written while R2 was on stay valid if it is later switched off, and
    // `mergeAuctionEdit` replays them through the validator on every edit. The
    // whitelist is about WHERE an image may come from, never about which
    // storage backend happens to be wired up right now.
    const db = seed([]);

    const response = await worker.fetch(
      new Request('https://msa-auction.test/api/auctions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${SELLER.token}` },
        body: JSON.stringify({
          title: 'A thing',
          description: 'Some description',
          phoneNumber: '0100000000',
          price: 10,
          imageUrls: [R2_PATH_A, PNG_DATA_URL],
        }),
      }),
      noBucketEnv(),
    );

    expect(response.status).toBe(201);
    expect(db.rows('auctions')[0].image_urls).toEqual([R2_PATH_A, PNG_DATA_URL]);
  });

  it('lets a seller edit a base64 listing with no binding bound', async () => {
    const db = seed([auctionRow({ image_urls: [PNG_DATA_URL, JPEG_DATA_URL] })]);

    const response = await worker.fetch(
      new Request('https://msa-auction.test/api/auctions/auc_01', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${SELLER.token}` },
        body: JSON.stringify({ title: 'Renamed lamp' }),
      }),
      noBucketEnv(),
    );

    expect(response.status).toBe(200);
    expect(db.rows('auctions')[0].image_urls).toEqual([PNG_DATA_URL, JPEG_DATA_URL]);
  });

  it('reads a listing back unchanged, images and all', async () => {
    seed([auctionRow({ image_urls: [PNG_DATA_URL], image_count: 1 })]);

    const single = await worker.fetch(new Request('https://msa-auction.test/api/auctions/auc_01'), noBucketEnv());
    expect(single.status).toBe(200);
    // GET /api/auctions/:id no longer carries image data at all - see the
    // "reports the right imageCount" test above. The actual image bytes are
    // unchanged, verified below via the dedicated images route.
    expect(((await single.json()) as any).auction.imageCount).toBe(1);

    const images = await worker.fetch(
      new Request('https://msa-auction.test/api/auctions/auc_01/images'),
      noBucketEnv(),
    );
    expect(images.status).toBe(200);
    expect(((await images.json()) as any).imageUrls).toEqual([PNG_DATA_URL]);
  });

  it('previews a shared link with the site logo, never a data URL', async () => {
    // With R2 off EVERY listing's first image is a data URL, so this is the
    // only og:image path that runs in production. Every share link previews as
    // the logo - which is the behaviour the site already had, not a regression.
    seed([auctionRow({ image_urls: [PNG_DATA_URL] })]);

    const assets = {
      fetch: async () =>
        new Response('<html><head><title>MSA</title></head><body></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    };

    const response = await worker.fetch(
      new Request('https://msa-auction.test/auction/auc_01'),
      noBucketEnv({ ASSETS: assets }),
    );
    const html = await response.text();

    expect(html).toContain('<meta property="og:image" content="https://msa-auction.test/MSA_Logo.png" />');
    // A data URL in og:image is rejected by every crawler and would bloat the
    // HTML with megabytes of base64 on a page a crawler fetches.
    expect(html).not.toContain('data:image');
  });

  it('answers all three R2 routes without throwing', async () => {
    seed([auctionRow()]);

    const responses = await Promise.all([
      worker.fetch(
        new Request('https://msa-auction.test/api/images', {
          method: 'POST',
          headers: { 'content-type': 'image/png', authorization: `Bearer ${SELLER.token}` },
          body: PNG_BYTES,
        }),
        noBucketEnv(),
      ),
      worker.fetch(
        new Request('https://msa-auction.test/images/11111111-2222-4333-8444-555555555555.png'),
        noBucketEnv(),
      ),
      worker.fetch(
        new Request('https://msa-auction.test/api/admin/migrate-images', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN.token}` },
          body: '{}',
        }),
        noBucketEnv(),
      ),
    ]);

    // Each one is a deliberate, structured answer. None is a 500, which is what
    // dereferencing the absent binding would have produced.
    expect(responses.map((response) => response.status)).toEqual([503, 404, 503]);
    for (const response of responses) {
      const body = (await response.json()) as any;
      expect(typeof body.code).toBe('string');
      expect(typeof body.error).toBe('string');
      expect(body.error.length).toBeGreaterThan(0);
    }
  });
});
