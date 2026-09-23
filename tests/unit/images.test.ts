/**
 * Client-side image compression (Fix 1a + the R1 revision: adaptive quality/size retry).
 *
 * `compressImageToBlob` itself needs a real `<canvas>` 2D context to draw onto, and jsdom does
 * not implement one without the `canvas` npm package (confirmed: `getContext('2d')` returns
 * `null` here, logging "Not implemented: HTMLCanvasElement's getContext()"). That is not
 * something this project already depends on, so it is NOT installed here to make this one test
 * pass - these tests instead cover the pure logic `compressImageToBlob` was refactored to use
 * (`computeScaledDimensions`, `planNextCompressionStep`), plus the constants that describe its
 * behaviour (`MAX_IMAGE_DIMENSION`, `IMAGE_OUTPUT_QUALITY`, `CLIENT_IMAGE_TARGET_BYTES`). The
 * end-to-end "does it actually produce a JPEG blob at the right size" path is NOT covered by any
 * automated test in this repo (the existing e2e suite, `tests/e2e/auction-flow.spec.ts`, does not
 * touch image upload at all) - see the executor's report for what was checked manually instead.
 */
import { describe, it, expect } from 'vitest';
import {
  CLIENT_IMAGE_TARGET_BYTES,
  computeScaledDimensions,
  IMAGE_COMPRESSION_LADDER,
  IMAGE_OUTPUT_QUALITY,
  MAX_IMAGE_DIMENSION,
  planNextCompressionStep,
} from '../../src/lib/images';
import { MAX_INLINE_IMAGE_BYTES } from '../../workers/shared';

describe('MAX_IMAGE_DIMENSION', () => {
  it('is 1024, down from the old 1600', () => {
    expect(MAX_IMAGE_DIMENSION).toBe(1024);
  });
});

describe('IMAGE_OUTPUT_QUALITY', () => {
  it('is tuned around 0.7', () => {
    expect(IMAGE_OUTPUT_QUALITY).toBeGreaterThanOrEqual(0.6);
    expect(IMAGE_OUTPUT_QUALITY).toBeLessThanOrEqual(0.8);
  });
});

describe('computeScaledDimensions', () => {
  it('leaves an image already within the cap untouched', () => {
    expect(computeScaledDimensions(800, 600, 1024)).toEqual({ width: 800, height: 600 });
  });

  it('scales a wide 12MP-ish photo down to 1024 on the long edge', () => {
    // A typical 4000x3000 phone photo.
    expect(computeScaledDimensions(4000, 3000, 1024)).toEqual({ width: 1024, height: 768 });
  });

  it('scales a tall photo down to 1024 on the long edge', () => {
    expect(computeScaledDimensions(3000, 4000, 1024)).toEqual({ width: 768, height: 1024 });
  });

  it('never scales up a small image', () => {
    expect(computeScaledDimensions(200, 100, 1024)).toEqual({ width: 200, height: 100 });
  });

  it('never rounds a dimension down to zero', () => {
    expect(computeScaledDimensions(1, 10000, 1024)).toEqual({ width: 1, height: 1024 });
  });

  it('defaults to MAX_IMAGE_DIMENSION when no cap is given', () => {
    expect(computeScaledDimensions(4000, 3000)).toEqual(computeScaledDimensions(4000, 3000, MAX_IMAGE_DIMENSION));
  });
});

/* ========================================================================== */
/* R1: the client target must stay under the server's cap                    */
/* ========================================================================== */

describe('CLIENT_IMAGE_TARGET_BYTES', () => {
  it('is strictly less than the server-side MAX_INLINE_IMAGE_BYTES, so the two cannot cross', () => {
    // If this ever fails, a client-accepted image could still be rejected by
    // validateAuctionInput's server-side guard - which is exactly the bug this revision fixes.
    expect(CLIENT_IMAGE_TARGET_BYTES).toBeLessThan(MAX_INLINE_IMAGE_BYTES);
  });

  it('is 280KB', () => {
    expect(CLIENT_IMAGE_TARGET_BYTES).toBe(280 * 1024);
  });
});

/* ========================================================================== */
/* R1: the compression ladder and its pure retry planner                     */
/* ========================================================================== */

describe('IMAGE_COMPRESSION_LADDER', () => {
  it('starts at IMAGE_OUTPUT_QUALITY and MAX_IMAGE_DIMENSION', () => {
    expect(IMAGE_COMPRESSION_LADDER[0]).toEqual({ quality: IMAGE_OUTPUT_QUALITY, maxDimension: MAX_IMAGE_DIMENSION });
  });

  it('tries every quality step at the full dimension before shrinking the image', () => {
    const fullDimensionSteps = IMAGE_COMPRESSION_LADDER.filter((step) => step.maxDimension === MAX_IMAGE_DIMENSION);
    expect(fullDimensionSteps.length).toBeGreaterThanOrEqual(2);
    // Strictly decreasing quality within the first dimension.
    for (let i = 1; i < fullDimensionSteps.length; i += 1) {
      expect(fullDimensionSteps[i].quality).toBeLessThan(fullDimensionSteps[i - 1].quality);
    }
  });

  it('falls back to a smaller dimension once the full-size quality steps run out', () => {
    const smallerStep = IMAGE_COMPRESSION_LADDER.find((step) => step.maxDimension < MAX_IMAGE_DIMENSION);
    expect(smallerStep).toBeDefined();
  });
});

describe('planNextCompressionStep', () => {
  it('accepts a blob already at or under the target, regardless of which step produced it', () => {
    expect(planNextCompressionStep(0, CLIENT_IMAGE_TARGET_BYTES)).toEqual({ action: 'accept' });
    expect(planNextCompressionStep(3, 100)).toEqual({ action: 'accept' });
  });

  it('retries at the next rung of the ladder when over target', () => {
    const plan = planNextCompressionStep(0, CLIENT_IMAGE_TARGET_BYTES + 1);

    expect(plan).toEqual({ action: 'retry', attemptIndex: 1, step: IMAGE_COMPRESSION_LADDER[1] });
  });

  it('walks all the way down through every rung, one at a time', () => {
    let index = 0;
    let plan = planNextCompressionStep(index, CLIENT_IMAGE_TARGET_BYTES + 1);

    while (plan.action === 'retry') {
      expect(plan.attemptIndex).toBe(index + 1);
      index = plan.attemptIndex;
      plan = planNextCompressionStep(index, CLIENT_IMAGE_TARGET_BYTES + 1);
    }

    // Every rung was tried in order and the ladder was exhausted without ever accepting.
    expect(index).toBe(IMAGE_COMPRESSION_LADDER.length - 1);
    expect(plan).toEqual({ action: 'giveUp' });
  });

  it('gives up once the last rung is still over target', () => {
    const lastIndex = IMAGE_COMPRESSION_LADDER.length - 1;

    expect(planNextCompressionStep(lastIndex, CLIENT_IMAGE_TARGET_BYTES + 1)).toEqual({ action: 'giveUp' });
  });

  it('respects a custom target, not just the default', () => {
    expect(planNextCompressionStep(0, 50_000, 100_000)).toEqual({ action: 'accept' });
    expect(planNextCompressionStep(0, 150_000, 100_000)).toEqual({
      action: 'retry',
      attemptIndex: 1,
      step: IMAGE_COMPRESSION_LADDER[1],
    });
  });
});
