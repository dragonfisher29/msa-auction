/**
 * Minimal in-memory stand-in for an R2 bucket binding, the counterpart to
 * `fake-supabase.ts`.
 *
 * Only the surface the Worker actually touches is implemented: `put(key, bytes,
 * { httpMetadata })` and `get(key)`, where the returned object carries `body`,
 * `httpMetadata` and `httpEtag` the way a real `R2Object` does.
 *
 * WHY `body` IS A STREAM. The Worker hands `object.body` straight to a
 * `Response`, so a fake that returned a plain `Uint8Array` would let a bug
 * through: `new Response(someUint8Array)` happens to work, which would hide the
 * case where the value is not actually streamable. A `ReadableStream` is what
 * R2 returns, so it is what this returns.
 */

export interface FakeR2Object {
  key: string;
  body: ReadableStream<Uint8Array>;
  httpMetadata: { contentType?: string; cacheControl?: string };
  httpEtag: string;
  size: number;
  /** The stored bytes, for assertions. Not part of the real R2 surface. */
  bytes: Uint8Array;
}

interface StoredObject {
  bytes: Uint8Array;
  httpMetadata: { contentType?: string; cacheControl?: string };
}

export interface FakeR2Options {
  /**
   * Returns an error to throw instead of completing the put. Lets a test make
   * one specific row fail its upload without breaking the rest of the batch.
   */
  failPut?: (key: string, bytes: Uint8Array) => unknown | null;
}

export class FakeR2Bucket {
  readonly objects = new Map<string, StoredObject>();
  /** Every key ever written, in order, including overwrites. */
  readonly puts: string[] = [];

  constructor(private options: FakeR2Options = {}) {}

  async put(
    key: string,
    value: Uint8Array | ArrayBuffer,
    options?: { httpMetadata?: { contentType?: string; cacheControl?: string } },
  ): Promise<{ key: string }> {
    const bytes = value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value);

    const forced = this.options.failPut?.(key, bytes);
    if (forced) {
      throw forced instanceof Error ? forced : new Error(String((forced as any)?.message ?? forced));
    }

    this.puts.push(key);
    this.objects.set(key, { bytes, httpMetadata: { ...(options?.httpMetadata ?? {}) } });

    return { key };
  }

  async get(key: string): Promise<FakeR2Object | null> {
    const stored = this.objects.get(key);
    if (!stored) {
      return null;
    }

    return {
      key,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(stored.bytes);
          controller.close();
        },
      }),
      httpMetadata: { ...stored.httpMetadata },
      httpEtag: `"${key}"`,
      size: stored.bytes.length,
      bytes: stored.bytes,
    };
  }

  /** Test helper: the raw bytes at a key, or undefined. */
  bytesAt(key: string): Uint8Array | undefined {
    return this.objects.get(key)?.bytes;
  }

  get size(): number {
    return this.objects.size;
  }
}

export function createFakeR2(options: FakeR2Options = {}): FakeR2Bucket {
  return new FakeR2Bucket(options);
}

/* -------------------------------------------------------------------------- */
/* Image fixtures                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Byte sequences with REAL magic numbers, padded past the 12-byte minimum the
 * sniffer needs. These are not decodable images, and they do not need to be:
 * nothing in the upload or backfill path decodes pixels, it only identifies the
 * format from the leading bytes.
 */
export const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

export const JPEG_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x02, 0x03,
]);

export const GIF_BYTES = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0xff,
]);

export const WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);

/** Not an image in any accepted format - used for the mismatch tests. */
export const TEXT_BYTES = new Uint8Array([
  0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0x77, 0x6f, 0x72, 0x6c, 0x64, 0x21, 0x21, 0x21,
]);

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** A legacy inline image of the kind the backfill has to convert. */
export function dataUrl(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${toBase64(bytes)}`;
}

export const PNG_DATA_URL = dataUrl('image/png', PNG_BYTES);
export const JPEG_DATA_URL = dataUrl('image/jpeg', JPEG_BYTES);
