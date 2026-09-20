/**
 * Whether one account has dismissed the "add a recovery email" prompt in AccountView.
 *
 * Keyed per user id, exactly like `notificationStorage.ts` and deliberately NOT like the
 * globally-keyed watchlist in `App.tsx`: two students sharing a library browser must not have
 * one's dismissal hide the prompt from the other, who may be the one account that still has no
 * email and therefore no way back in after a forgotten password.
 *
 * Defensive on every path, for the same reasons as the notification store: localStorage throws
 * in private mode and with site data blocked, and a bad read must only cost the user a prompt
 * they can dismiss again -- never take the account page down.
 */

const KEY_PREFIX = 'msa_email_prompt_dismissed';

/** The storage key for one user. Exported so tests can address it directly. */
export function emailPromptDismissedKey(userId: string): string {
  return `${KEY_PREFIX}_${userId}`;
}

export function isEmailPromptDismissed(userId: string): boolean {
  try {
    return localStorage.getItem(emailPromptDismissedKey(userId)) === '1';
  } catch {
    // Storage unavailable: show the prompt. Nagging is the safe failure here, because the
    // alternative is an account that silently keeps its permanent lockout risk.
    return false;
  }
}

export function dismissEmailPrompt(userId: string): void {
  try {
    localStorage.setItem(emailPromptDismissedKey(userId), '1');
  } catch {
    // The prompt reappears next visit; never fatal.
  }
}

/**
 * Called once an email is actually saved. The prompt is already hidden by the live `user.email`
 * at that point, so this only stops a stale "dismissed" flag outliving the problem it was
 * hiding -- if the address is ever removed, the prompt should come back.
 */
export function clearEmailPromptDismissal(userId: string): void {
  try {
    localStorage.removeItem(emailPromptDismissedKey(userId));
  } catch {
    // ignore
  }
}
