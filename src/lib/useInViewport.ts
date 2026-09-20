import { useEffect, useRef, useState, type RefObject } from 'react';

/**
 * True once the referenced element has entered (or come near) the viewport, and stays true
 * afterwards -- callers that only need to trigger a one-time lazy load (like AuctionCard's
 * image fetch) don't want it to flip back to false the moment the card scrolls back out.
 *
 * Falls back to `true` immediately in environments without `IntersectionObserver` (older
 * browsers, or a test that hasn't polyfilled it) so lazy content still loads rather than
 * staying blank forever.
 */
export function useInViewport<T extends Element>(rootMargin = '200px'): [RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [isInViewport, setIsInViewport] = useState(false);

  useEffect(() => {
    if (isInViewport) {
      return;
    }

    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      setIsInViewport(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setIsInViewport(true);
        }
      },
      { rootMargin },
    );

    observer.observe(node);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isInViewport, rootMargin]);

  return [ref, isInViewport];
}
