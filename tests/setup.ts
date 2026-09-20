import '@testing-library/jest-dom/vitest';

// jsdom has no IntersectionObserver. Components that lazy-load on viewport entry (AuctionCard's
// image fetch) need one to exist at all; this default stub reports every observed element as
// immediately intersecting, so lazy content loads right away unless a specific test installs its
// own controllable mock (see tests/components/AuctionCard.test.tsx).
if (typeof (globalThis as any).IntersectionObserver === 'undefined') {
  class ImmediateIntersectionObserver implements IntersectionObserver {
    readonly root: Element | Document | null = null;
    readonly rootMargin: string = '';
    readonly thresholds: ReadonlyArray<number> = [];
    private callback: IntersectionObserverCallback;

    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback;
    }

    observe(target: Element): void {
      this.callback(
        [
          {
            isIntersecting: true,
            target,
            boundingClientRect: target.getBoundingClientRect(),
            intersectionRatio: 1,
            intersectionRect: target.getBoundingClientRect(),
            rootBounds: null,
            time: Date.now(),
          } as IntersectionObserverEntry,
        ],
        this,
      );
    }

    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }

  (globalThis as any).IntersectionObserver = ImmediateIntersectionObserver;
}
