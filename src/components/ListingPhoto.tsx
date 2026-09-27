import React from 'react';

interface ListingPhotoProps {
  src: string;
  alt: string;
  /** Sizing for the frame (the box stays whatever size the caller gives it; the photo adapts). */
  className?: string;
  /** Extra classes for the foreground photo only, e.g. the card's hover zoom. */
  photoClassName?: string;
  /** Desaturates both layers -- used for a listing that is no longer for sale. */
  muted?: boolean;
  /** Off-screen cards defer the download; the detail gallery wants its photo straight away. */
  lazy?: boolean;
}

/**
 * A listing photo inside a fixed-size frame, shown whole rather than cropped. Photos are stored
 * uncropped at whatever aspect ratio the seller took them, so a plain `object-cover` in a
 * landscape box would cut off half of a portrait phone shot.
 *
 * Two layers from the same `src` (one request, one cached decode):
 *  - behind: the photo stretched to cover the frame, heavily blurred and scaled up slightly so
 *    the soft edges of the blur never show -- fills the letterbox bars with the photo's own colours;
 *  - in front: the full photo with `object-contain`, carrying the real alt text.
 */
export const ListingPhoto: React.FC<ListingPhotoProps> = ({
  src,
  alt,
  className = '',
  photoClassName = '',
  muted = false,
  lazy = false,
}) => {
  const loadingProps = lazy ? ({ loading: 'lazy', decoding: 'async' } as const) : {};
  const mutedClass = muted ? 'grayscale-[60%]' : '';

  return (
    <div className={`relative w-full overflow-hidden ${className}`}>
      <img
        src={src}
        alt=""
        aria-hidden="true"
        referrerPolicy="no-referrer"
        {...loadingProps}
        className={`absolute inset-0 w-full h-full object-cover blur-xl scale-110 brightness-90 saturate-75 ${mutedClass}`}
      />
      <img
        src={src}
        alt={alt}
        referrerPolicy="no-referrer"
        {...loadingProps}
        className={`relative w-full h-full object-contain ${mutedClass} ${photoClassName}`}
      />
    </div>
  );
};
