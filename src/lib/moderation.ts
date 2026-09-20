/**
 * The client's view of the reporting vocabulary.
 *
 * `REPORT_REASONS` here is a deliberate mirror of the same constant in `workers/shared.ts`,
 * which is the authority: `createAuctionReport` rejects anything outside it with
 * `INVALID_REPORT_REASON`. It is duplicated rather than imported because `workers/shared.ts`
 * is server code (it reaches for Supabase and the Worker `crypto` global) and pulling it into
 * the browser bundle to read five strings would be a poor trade. The list is short, closed,
 * and changing it is already a schema-level decision, so the drift risk is small and loud --
 * a reason the server does not know comes straight back as a 400.
 *
 * The labels exist because the raw enum values are database tokens, not English:
 * "wrong_category" in front of a student is a bug, not a choice.
 */

export const REPORT_REASONS = ['scam', 'prohibited', 'offensive', 'wrong_category', 'other'] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];

interface ReportReasonOption {
  value: ReportReason;
  label: string;
  /** One line under the label, so a reporter picks the right bucket the first time. */
  hint: string;
}

export const REPORT_REASON_OPTIONS: ReportReasonOption[] = [
  {
    value: 'scam',
    label: 'Scam or fraud',
    hint: 'The seller looks fake, or is asking for payment off the platform.',
  },
  {
    value: 'prohibited',
    label: 'Prohibited item',
    hint: 'Something that is not allowed to be sold here.',
  },
  {
    value: 'offensive',
    label: 'Offensive content',
    hint: 'The title, description or photos are abusive or inappropriate.',
  },
  {
    value: 'wrong_category',
    label: 'Listed in the wrong category',
    hint: 'The item is real, it is just filed somewhere it does not belong.',
  },
  {
    value: 'other',
    label: 'Something else',
    hint: 'Tell the committee what is wrong in the box below.',
  },
];

/** Human label for a reason string that came back from the server (admin queue). */
export function reportReasonLabel(reason: string): string {
  return REPORT_REASON_OPTIONS.find((option) => option.value === reason)?.label ?? reason;
}

/** `REPORT_DETAILS_LIMIT` in workers/shared.ts. Enforced here only to save a round trip. */
export const REPORT_DETAILS_MAX_LENGTH = 1000;

/** `BAN_REASON_LIMIT` / `HIDE_REASON_LIMIT` in workers/shared.ts. */
export const MODERATION_REASON_MAX_LENGTH = 500;
