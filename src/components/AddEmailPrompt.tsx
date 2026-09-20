import React, { useState } from 'react';
import { AlertCircle, CheckCircle2, Mail, X } from 'lucide-react';
import { User } from '../types';
import { apiFetchAuthed } from '../lib/api';
import { AUTH_ERROR_CODES, EMAIL_TAKEN, INVALID_EMAIL, readErrorCode, stripErrorCode } from '../lib/apiErrors';
import { clearEmailPromptDismissal, dismissEmailPrompt, isEmailPromptDismissed } from '../lib/emailPromptStorage';

interface AddEmailPromptProps {
  user: User;
  /** Called with the saved address so App can update the session it holds and persists. */
  onEmailSaved: (email: string) => void;
}

/**
 * Shown in AccountView to a signed-in user with no recovery address on file.
 *
 * Most accounts predate emails entirely, and an account with no email cannot be recovered at
 * all -- `createPasswordResetRequest` does nothing for a row with a null email, so a forgotten
 * password means a new account. That is worth one prompt.
 *
 * It is worth exactly one prompt, though, so the dismissal sticks. It is stored per user id
 * (see `emailPromptStorage.ts`) rather than under a single global key: on a shared browser, one
 * student dismissing it must not hide it from the next student, who may be the one who needs it.
 */
export const AddEmailPrompt: React.FC<AddEmailPromptProps> = ({ user, onEmailSaved }) => {
  // Read once on mount. Re-reading on every render would fight the local `isDismissed` state
  // below and make the dismiss click appear to do nothing until a reload.
  const [isDismissed, setIsDismissed] = useState(() => isEmailPromptDismissed(user.id));
  const [email, setEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedEmail, setSavedEmail] = useState<string | null>(null);

  // An address already on file makes the whole prompt moot.
  if (user.email) {
    return null;
  }

  if (isDismissed && !savedEmail) {
    return null;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!email.trim()) {
      setError('Enter an email address to save.');
      return;
    }

    setIsSubmitting(true);

    try {
      const res = await apiFetchAuthed('/api/auth/email', user.token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        const code = readErrorCode(data);

        if (code && AUTH_ERROR_CODES.has(code)) {
          setError('Your session has expired. Please sign in again to save an email address.');
          return;
        }
        if (code === INVALID_EMAIL) {
          setError('That does not look like a valid email address.');
          return;
        }
        if (code === EMAIL_TAKEN) {
          setError('That address is already attached to another account.');
          return;
        }

        setError(data?.error ? stripErrorCode(data.error) : 'Unable to save your email address. Please try again.');
        return;
      }

      const saved = typeof data?.email === 'string' ? data.email : email.trim();
      // A stale "dismissed" flag must not outlive the problem: if this address is ever removed,
      // the prompt should be free to come back.
      clearEmailPromptDismissal(user.id);
      setSavedEmail(saved);
      onEmailSaved(saved);
    } catch (err) {
      console.error('Failed to save email address:', err);
      setError('Network error while saving your email address. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (savedEmail) {
    return (
      <div
        id="add-email-saved"
        role="status"
        className="p-3 rounded-2xl bg-emerald-100/95 border border-emerald-200 text-emerald-900 text-xs flex items-start gap-2"
      >
        <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
        <span>
          Saved. <strong className="font-bold break-all">{savedEmail}</strong> is now on your
          account, so a forgotten password can be recovered.
        </span>
      </div>
    );
  }

  return (
    <section
      id="add-email-prompt"
      aria-labelledby="add-email-prompt-heading"
      className="p-3 sm:p-4 rounded-2xl bg-amber-100/90 border border-amber-300 text-amber-900 space-y-3"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 id="add-email-prompt-heading" className="text-sm font-extrabold flex items-center gap-2 min-w-0">
          <Mail className="w-4 h-4 shrink-0" />
          <span>Add an email so you can get back in</span>
        </h3>
        <button
          id="add-email-dismiss-btn"
          type="button"
          onClick={() => {
            dismissEmailPrompt(user.id);
            setIsDismissed(true);
          }}
          aria-label="Dismiss the add email prompt"
          className="shrink-0 inline-flex items-center justify-center p-2 min-h-[44px] min-w-[44px] rounded-lg text-amber-900/70 hover:text-amber-900 hover:bg-amber-200 transition-colors cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <p className="text-xs">
        Your account has no email address. If you forget your password there is no way to reset
        it on your own — you would have to ask a committee member to help you back in, or start
        a new account and lose your listing history.
      </p>

      {error && (
        <div
          role="alert"
          className="p-2.5 rounded-xl bg-red-100/95 border border-red-200 text-red-800 text-xs flex items-center gap-2"
        >
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row items-stretch sm:items-end gap-2">
        <div className="flex-1 min-w-0">
          <label htmlFor="add-email-input" className="block text-xs font-bold mb-1">
            Email address
          </label>
          <input
            id="add-email-input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setError(null);
            }}
            placeholder="e.g. alex@example.com"
            className="w-full px-3 py-2 min-h-[44px] text-sm rounded-xl bg-[#edf2fb] border border-amber-300 focus:border-amber-500 focus:outline-hidden text-[#1e293b] placeholder-[#1e293b]/40 font-medium"
          />
        </div>
        <button
          id="add-email-submit-btn"
          type="submit"
          disabled={isSubmitting}
          className="shrink-0 inline-flex items-center justify-center gap-1.5 px-4 min-h-[44px] rounded-xl bg-[#1e293b] hover:bg-[#334155] text-xs font-extrabold text-white transition-colors disabled:opacity-60 cursor-pointer"
        >
          <Mail className="w-3.5 h-3.5" />
          <span>{isSubmitting ? 'Saving...' : 'Save Email'}</span>
        </button>
      </form>
    </section>
  );
};
