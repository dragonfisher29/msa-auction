/**
 * Neutral stand-in for a listing with no usable photo (none uploaded, or the image fetch
 * failed). An inline SVG rather than a hosted image: it costs no request, works offline, and
 * never sends a visitor's IP to a third-party image host.
 *
 * Colours are the app's own muted blues; the glyph is a plain "picture" outline so it reads as
 * "no photo" rather than as a real product shot.
 */
const PLACEHOLDER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">' +
  '<rect width="800" height="600" fill="#d7e3fc"/>' +
  '<g fill="none" stroke="#1e293b" stroke-opacity="0.35" stroke-width="12" stroke-linejoin="round" stroke-linecap="round">' +
  '<rect x="310" y="220" width="180" height="140" rx="16"/>' +
  '<circle cx="360" cy="265" r="16"/>' +
  '<path d="M318 345l58-58 42 42 26-26 46 42"/>' +
  '</g>' +
  '</svg>';

export const PLACEHOLDER_IMAGE_URL = `data:image/svg+xml;utf8,${encodeURIComponent(PLACEHOLDER_SVG)}`;
