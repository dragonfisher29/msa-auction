import React, { useState } from 'react';
import { AlertCircle, ArrowRight, KeyRound, Lock } from 'lucide-react';
import { User } from '../types';
import { apiFetch, apiFetchAuthed } from '../lib/api';
import { DEAD_RESET_TOKEN_CODES, readErrorCode, stripErrorCode } from '../lib/apiErrors';

interface ResetPasswordViewProps {
  /** Raw token from `?token=` on `/reset-password`. Empty when the link was mangled. */
  token: string;
  /** Signs the user in with the fresh session the reset returns, then App sends them home. */
  onResetComplete: (user: User) => void;
  /** Opens AuthModal on its "forgot password" form, for a dead or missing token. */
  onRequestNewLink: () => void;
  onClose: () => void;
}

/**
 * `/reset-password?token=...`.
 *
 * A successful reset mints a NEW session token server-side (which also signs every other
 * session out), so there is nothing to sign in with afterwards -- the sensible thing is to use
 * it immediately rather than bounce the user to a login form with the password they just typed.
 *
 * The three token failures (never valid / expired / already used) are deliberately shown with
 * one shared message. They are the same situation from the user's side -- this link is dead --
 * and distinguishing "already used" from "never existed" tells anyone holding a stolen link
 * something about what the real owner did with it.
 */
export const ResetPasswordView: React.FC<ResetPasswordViewProps> = ({
  token,
  onResetComplete,
  onRequestNewLink,
  onClose,
}) => {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Separates "this link is dead" from "that did not work, try again": only the first one is
  // fixed by requesting a new link, so only it offers that button.
  const [isTokenDead, setIsTokenDead] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsTokenDead(false);

    if (!token) {
      setIsTokenDead(true);
      setError('This reset link is incomplete. Please request a new one.');
      return;
    }
    if (password.trim().length === 0) {
      setError('Enter your new password.');
      return;
    }
    if (password !== confirmPassword) {
      setError('The two passwords do not match.');
      return;
    }

    setIsSubmitting(true);

    try {
      const res = await apiFetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword: password }),
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        const code = readErrorCode(data);

        if (code && DEAD_RESET_TOKEN_CODES.has(code)) {
          setIsTokenDead(true);
          setError('This reset link is no longer valid. Links last 60 minutes and can only be used once.');
          return;
        }

        setError(data?.error ? stripErrorCode(data.error) : 'Unable to reset your password. Please try again.');
        return;
      }

      const resetUser = data?.user as User | undefined;
      if (!resetUser?.token) {
        setError('Your password was changed, but signing you in failed. Please sign in manually.');
        return;
      }

      // The reset response carries only id/name/username/token. Hydrate `role` and `email` from
      // /api/auth/me with the brand new session so the header and account page look the same
      // after a reset as after an ordinary sign-in. A failure here is not worth blocking on --
      // the session is valid either way, and the next page load fills the gap.
      let signedInUser = resetUser;
      try {
        const meRes = await apiFetchAuthed('/api/auth/me', resetUser.token);
        if (meRes.ok) {
          const meData = await meRes.json().catch(() => null);
          if (meData?.user) {
            signedInUser = { ...resetUser, ...meData.user, token: resetUser.token };
          }
        }
      } catch (err) {
        console.warn('Could not hydrate the session after a password reset:', err);
      }

      onResetComplete(signedInUser);
    } catch (err) {
      console.error('Failed to reset password:', err);
      setError('Network error while resetting your password. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="max-w-md mx-auto w-full bg-[#e2eafc] border border-[#ccdbfd] rounded-2xl p-4 sm:p-6 shadow-xs space-y-4">
      <div>
        <h2 className="text-lg sm:text-2xl font-black text-[#1e293b] tracking-tight flex items-center gap-2">
          <KeyRound className="w-5 h-5 shrink-0" />
          <span>Choose a New Password</span>
        </h2>
        <p className="text-xs sm:text-sm text-[#1e293b]/75 mt-1">
          Setting a new password signs you in and signs out anywhere else you were signed in.
        </p>
      </div>

      {error && (
        <div
          id="reset-password-error"
          role="alert"
          className="p-3 rounded-xl bg-red-100/95 border border-red-200 text-red-800 text-xs flex flex-wrap items-center gap-2"
        >
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
          {isTokenDead && (
            <button
              id="reset-password-new-link-btn"
              type="button"
              onClick={onRequestNewLink}
              className="shrink-0 inline-flex items-center justify-center px-3 min-h-[44px] rounded-xl bg-[#abc4ff] hover:bg-[#b6ccfe] border border-[#c1d3fe] text-[#1e293b] font-extrabold transition-colors cursor-pointer"
            >
              Request a New Link
            </button>
          )}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="reset-password-input" className="block text-xs font-bold text-[#1e293b] mb-1">
            New Password
          </label>
          <div className="relative">
            <Lock className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#1e293b]/50" />
            <input
              id="reset-password-input"
              type="password"
              required
              autoComplete="new-password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
              }}
              className="w-full pl-9 pr-3 py-2 min-h-[44px] text-sm rounded-xl bg-[#edf2fb] border border-[#ccdbfd] focus:border-[#abc4ff] focus:outline-hidden text-[#1e293b] placeholder-[#1e293b]/40 font-medium"
            />
          </div>
        </div>

        <div>
          <label htmlFor="reset-password-confirm-input" className="block text-xs font-bold text-[#1e293b] mb-1">
            Confirm New Password
          </label>
          <div className="relative">
            <Lock className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#1e293b]/50" />
            <input
              id="reset-password-confirm-input"
              type="password"
              required
              autoComplete="new-password"
              placeholder="••••••••"
              value={confirmPassword}
              onChange={(e) => {
                setConfirmPassword(e.target.value);
                setError(null);
              }}
              className="w-full pl-9 pr-3 py-2 min-h-[44px] text-sm rounded-xl bg-[#edf2fb] border border-[#ccdbfd] focus:border-[#abc4ff] focus:outline-hidden text-[#1e293b] placeholder-[#1e293b]/40 font-medium"
            />
          </div>
        </div>

        <button
          id="reset-password-submit-btn"
          type="submit"
          disabled={isSubmitting}
          className="w-full py-2.5 px-4 min-h-[44px] rounded-xl bg-[#abc4ff] hover:bg-[#b6ccfe] border border-[#c1d3fe] text-[#1e293b] font-bold text-sm shadow-xs transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
        >
          <span>{isSubmitting ? 'Saving...' : 'Set Password & Sign In'}</span>
          <ArrowRight className="w-4 h-4 shrink-0" />
        </button>
      </form>

      <button
        id="reset-password-back-btn"
        type="button"
        onClick={onClose}
        className="w-full inline-flex items-center justify-center px-3 min-h-[44px] rounded-xl bg-[#d7e3fc] hover:bg-[#c1d3fe] text-xs font-bold text-[#1e293b] transition-colors cursor-pointer"
      >
        Back to Auctions
      </button>
    </div>
  );
};
