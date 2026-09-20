import React, { useState } from 'react';
import {
  X,
  Lock,
  Mail,
  User as UserIcon,
  UserCheck,
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  KeyRound,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { User } from '../types';

export type AuthModalMode = 'login' | 'register' | 'forgot';

interface AuthModalProps {
  isOpen: boolean;
  /** Which tab/form to open on. Defaults to sign-in. */
  initialMode?: AuthModalMode;
  onClose: () => void;
  onAuthSuccess: (user: User) => void;
}

export const AuthModal: React.FC<AuthModalProps> = ({
  isOpen,
  initialMode = 'login',
  onClose,
  onAuthSuccess,
}) => {
  const [mode, setMode] = useState<AuthModalMode>(initialMode);
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // "Forgot password" fields. Kept separate from `username` above so switching tabs does not
  // carry a half-typed login into the recovery form or the other way round.
  const [resetIdentifier, setResetIdentifier] = useState('');
  const [isResetRequested, setIsResetRequested] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    const endpoint = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
    const payload = mode === 'login'
      ? { username, password }
      // Email is optional at registration, so an empty box is simply not sent -- the server
      // treats an absent email as "no recovery address" rather than as a validation failure.
      : { username, name, password, ...(email.trim() ? { email: email.trim() } : {}) };

    try {
      const res = await apiFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Authentication failed. Please check your credentials.');
      }

      onAuthSuccess(data.user);
      onClose();
    } catch (err: any) {
      setError(err.message || 'An error occurred');
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * `POST /api/auth/request-reset`.
   *
   * The server answers an identical 200 whether or not the account exists, on purpose: a
   * different answer would turn this box into a "does @someone have an account here" oracle.
   * This handler must not undo that. So there is no branching on the response body, and even a
   * network failure lands on the same confirmation -- an error shown for an unknown username
   * and not for a known one would leak exactly what the server refused to say.
   */
  const handleRequestReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      await apiFetch('/api/auth/request-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usernameOrEmail: resetIdentifier.trim() }),
      });
    } catch (err) {
      console.warn('Reset request failed to send:', err);
    } finally {
      setIsLoading(false);
      setIsResetRequested(true);
    }
  };

  const switchMode = (next: AuthModalMode) => {
    setMode(next);
    setError(null);
    setIsResetRequested(false);
  };

  const headingText =
    mode === 'login' ? 'Sign In to MSA Auction' : mode === 'register' ? 'Create an Account' : 'Reset Your Password';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-[#1e293b]/40 backdrop-blur-xs overflow-y-auto">
      <div className="relative w-full max-w-md bg-[#e2eafc] border border-[#ccdbfd] rounded-2xl shadow-xl overflow-hidden text-[#1e293b] my-2 sm:my-4 flex flex-col modal-max-h">

        {/* Modal Header */}
        <div className="flex items-center justify-between gap-2 px-4 sm:px-6 py-3 sm:py-4 border-b border-[#ccdbfd] bg-[#d7e3fc] shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 shrink-0 rounded-lg bg-[#b6ccfe] flex items-center justify-center text-[#1e293b]">
              {mode === 'forgot' ? <KeyRound className="w-4 h-4" /> : <Lock className="w-4 h-4" />}
            </div>
            <h2 className="text-sm sm:text-lg font-bold text-[#1e293b] leading-tight min-w-0">
              {headingText}
            </h2>
          </div>
          <button
            id="close-auth-modal-btn"
            onClick={onClose}
            aria-label="Close sign in dialog"
            className="shrink-0 inline-flex items-center justify-center p-2 min-h-[44px] min-w-[44px] rounded-lg text-[#1e293b]/70 hover:text-[#1e293b] hover:bg-[#c1d3fe] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto overscroll-contain">
        {/* Mode Switcher Tabs. Hidden on the recovery form, which is a detour off the sign-in
            tab rather than a third peer of it -- it has its own "back" control below. */}
        {mode !== 'forgot' && (
          <div className="grid grid-cols-2 p-1.5 mx-4 sm:mx-6 mt-4 sm:mt-5 bg-[#d7e3fc] border border-[#ccdbfd] rounded-xl text-sm font-semibold">
            <button
              id="tab-login-btn"
              type="button"
              onClick={() => switchMode('login')}
              className={`py-2 min-h-[44px] rounded-lg transition-all ${
                mode === 'login'
                  ? 'bg-[#abc4ff] text-[#1e293b] shadow-xs'
                  : 'text-[#1e293b]/70 hover:text-[#1e293b]'
              }`}
            >
              Sign In
            </button>
            <button
              id="tab-register-btn"
              type="button"
              onClick={() => switchMode('register')}
              className={`py-2 min-h-[44px] rounded-lg transition-all ${
                mode === 'register'
                  ? 'bg-[#abc4ff] text-[#1e293b] shadow-xs'
                  : 'text-[#1e293b]/70 hover:text-[#1e293b]'
              }`}
            >
              Register
            </button>
          </div>
        )}

        {/* Form Body */}
        <div className="p-4 sm:p-6">
          {error && (
            <div
              role="alert"
              className="mb-4 p-3 rounded-xl bg-red-100/90 border border-red-200 text-red-800 text-xs flex items-center gap-2"
            >
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {mode === 'forgot' ? (
            isResetRequested ? (
              <div className="space-y-4">
                {/* The SAME message regardless of whether that account exists. See
                    handleRequestReset -- the server refuses to say, and neither does this. */}
                <div
                  id="reset-request-confirmation"
                  role="status"
                  className="p-3 rounded-xl bg-emerald-100/95 border border-emerald-200 text-emerald-900 text-xs flex items-start gap-2"
                >
                  <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>
                    If that account exists, a reset link has been created for it.
                  </span>
                </div>

                <div className="p-3 rounded-xl bg-amber-100/90 border border-amber-300 text-amber-900 text-xs space-y-1">
                  <p className="font-extrabold">No email will arrive.</p>
                  <p>
                    Automatic email is not set up yet, so nothing has been sent to your inbox.
                    Message an MSA committee member and ask them for your reset link — they can
                    read it from the admin panel and pass it to you. Links last 60 minutes from
                    the moment they hand it over.
                  </p>
                </div>

                <button
                  id="reset-request-back-btn"
                  type="button"
                  onClick={() => switchMode('login')}
                  className="w-full inline-flex items-center justify-center gap-1.5 px-3 min-h-[44px] rounded-xl bg-[#d7e3fc] hover:bg-[#c1d3fe] text-xs font-bold text-[#1e293b] transition-colors cursor-pointer"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  <span>Back to Sign In</span>
                </button>
              </div>
            ) : (
              <form onSubmit={handleRequestReset} className="space-y-4">
                <p className="text-xs text-[#1e293b]/80">
                  Enter your username or the email address on your account. A committee member
                  will pass you the reset link — see the note after you submit.
                </p>

                <div>
                  <label htmlFor="reset-identifier-input" className="block text-xs font-bold text-[#1e293b] mb-1">
                    Username or Email
                  </label>
                  <div className="relative">
                    <UserIcon className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#1e293b]/50" />
                    <input
                      id="reset-identifier-input"
                      type="text"
                      required
                      placeholder="alex_r or alex@example.com"
                      value={resetIdentifier}
                      onChange={(e) => setResetIdentifier(e.target.value)}
                      className="w-full pl-9 pr-3 py-2 min-h-[44px] text-sm rounded-xl bg-[#edf2fb] border border-[#ccdbfd] focus:border-[#abc4ff] focus:outline-hidden text-[#1e293b] placeholder-[#1e293b]/40 font-medium"
                    />
                  </div>
                </div>

                <button
                  id="reset-request-submit-btn"
                  type="submit"
                  disabled={isLoading}
                  className="w-full py-2.5 px-4 min-h-[44px] rounded-xl bg-[#abc4ff] hover:bg-[#b6ccfe] border border-[#c1d3fe] text-[#1e293b] font-bold text-sm shadow-xs transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
                >
                  <span>{isLoading ? 'Requesting...' : 'Request Reset Link'}</span>
                  <ArrowRight className="w-4 h-4 shrink-0" />
                </button>

                <button
                  id="reset-request-cancel-btn"
                  type="button"
                  onClick={() => switchMode('login')}
                  className="w-full inline-flex items-center justify-center gap-1.5 px-3 min-h-[44px] rounded-xl bg-[#d7e3fc] hover:bg-[#c1d3fe] text-xs font-bold text-[#1e293b] transition-colors cursor-pointer"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  <span>Back to Sign In</span>
                </button>
              </form>
            )
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {mode === 'register' && (
                <div>
                  <label htmlFor="register-name-input" className="block text-xs font-bold text-[#1e293b] mb-1">
                    Full Name
                  </label>
                  <div className="relative">
                    <UserCheck className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#1e293b]/50" />
                    <input
                      id="register-name-input"
                      type="text"
                      required
                      placeholder="e.g. Jordan Hayes"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="w-full pl-9 pr-3 py-2 min-h-[44px] text-sm rounded-xl bg-[#edf2fb] border border-[#ccdbfd] focus:border-[#abc4ff] focus:outline-hidden text-[#1e293b] placeholder-[#1e293b]/40 font-medium"
                    />
                  </div>
                </div>
              )}

              <div>
                <label htmlFor="auth-username-input" className="block text-xs font-bold text-[#1e293b] mb-1">
                  Username
                </label>
                <div className="relative">
                  <UserIcon className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#1e293b]/50" />
                  <input
                    id="auth-username-input"
                    type="text"
                    required
                    placeholder="e.g. alex_r"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="w-full pl-9 pr-3 py-2 min-h-[44px] text-sm rounded-xl bg-[#edf2fb] border border-[#ccdbfd] focus:border-[#abc4ff] focus:outline-hidden text-[#1e293b] placeholder-[#1e293b]/40 font-medium"
                  />
                </div>
              </div>

              {/* Optional, and said so plainly. It is the ONLY way to recover a forgotten
                  password later, so the cost of leaving it blank is spelled out rather than
                  discovered months afterwards. */}
              {mode === 'register' && (
                <div>
                  <label htmlFor="register-email-input" className="block text-xs font-bold text-[#1e293b] mb-1">
                    Email <span className="font-medium text-[#1e293b]/60">(optional)</span>
                  </label>
                  <div className="relative">
                    <Mail className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#1e293b]/50" />
                    <input
                      id="register-email-input"
                      type="email"
                      autoComplete="email"
                      placeholder="e.g. alex@example.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      aria-describedby="register-email-hint"
                      className="w-full pl-9 pr-3 py-2 min-h-[44px] text-sm rounded-xl bg-[#edf2fb] border border-[#ccdbfd] focus:border-[#abc4ff] focus:outline-hidden text-[#1e293b] placeholder-[#1e293b]/40 font-medium"
                    />
                  </div>
                  <p id="register-email-hint" className="text-[11px] text-[#1e293b]/70 mt-1">
                    Without one, a forgotten password cannot be recovered — you would need a
                    committee member to help you back in.
                  </p>
                </div>
              )}

              <div>
                <label htmlFor="auth-password-input" className="block text-xs font-bold text-[#1e293b] mb-1">
                  Password
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#1e293b]/50" />
                  <input
                    id="auth-password-input"
                    type="password"
                    required
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full pl-9 pr-3 py-2 min-h-[44px] text-sm rounded-xl bg-[#edf2fb] border border-[#ccdbfd] focus:border-[#abc4ff] focus:outline-hidden text-[#1e293b] placeholder-[#1e293b]/40 font-medium"
                  />
                </div>
              </div>

              <button
                id="auth-submit-btn"
                type="submit"
                disabled={isLoading}
                className="w-full py-2.5 px-4 min-h-[44px] rounded-xl bg-[#abc4ff] hover:bg-[#b6ccfe] border border-[#c1d3fe] text-[#1e293b] font-bold text-sm shadow-xs transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
              >
                <span>{isLoading ? 'Processing...' : mode === 'login' ? 'Sign In' : 'Create Account'}</span>
                <ArrowRight className="w-4 h-4 shrink-0" />
              </button>

              {mode === 'login' && (
                <button
                  id="forgot-password-btn"
                  type="button"
                  onClick={() => switchMode('forgot')}
                  className="w-full inline-flex items-center justify-center px-3 min-h-[44px] rounded-xl text-xs font-bold text-[#1e293b] underline underline-offset-2 hover:bg-[#d7e3fc] transition-colors cursor-pointer"
                >
                  Forgot password?
                </button>
              )}
            </form>
          )}

        </div>
        </div>
      </div>
    </div>
  );
};
