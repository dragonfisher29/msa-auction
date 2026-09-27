/**
 * The site's display name, in one place. Every piece of UI copy that names the site reads it
 * from here, so a rename is a one-line change.
 *
 * Not used for storage keys (`msa_auction_user`, `msa_watchlist_ids`): renaming those would sign
 * every existing visitor out and wipe their watchlist for no visible gain.
 */
export const SITE_NAME = 'MSA Auction';

/** One-line description used under the name in the header and in the footer. */
export const SITE_TAGLINE = 'Buy and sell with fellow MSA Southampton members';
