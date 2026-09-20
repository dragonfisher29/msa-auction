import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  Ban,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  EyeOff,
  Flag,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  UserCheck,
} from 'lucide-react';
import { AdminReport, AdminResetRequest, User } from '../types';
import { apiFetchAuthed } from '../lib/api';
import { describeModerationError, NOT_ADMIN, readErrorCode } from '../lib/apiErrors';
import { MODERATION_REASON_MAX_LENGTH, reportReasonLabel } from '../lib/moderation';
import { formatDateTime, formatTimeRemaining } from '../lib/formatters';
import { HideListingModal } from './HideListingModal';

interface AdminViewProps {
  /** Non-null by construction: App only routes here for a signed-in user whose role is admin. */
  user: User;
  onClose: () => void;
  /** Opens `/auction/:id`, so an admin can see what was reported before acting on it. */
  onOpenAuctionById: (auctionId: string) => void;
}

/** The listing a hide confirmation is currently open for. */
interface HideTarget {
  auctionId: string;
  auctionTitle: string | null;
}

const sectionClass = 'bg-[#e2eafc] border border-[#ccdbfd] rounded-2xl p-4 sm:p-5 shadow-xs space-y-3';
const inputClass =
  'w-full px-3 py-2 min-h-[44px] text-sm rounded-xl bg-[#edf2fb] border border-[#ccdbfd] focus:border-[#abc4ff] focus:outline-hidden text-[#1e293b] placeholder-[#1e293b]/40 font-medium';

/** Copy-to-clipboard button that confirms itself for two seconds, as the detail modal's does. */
const CopyButton: React.FC<{ value: string; label: string; id: string }> = ({ value, label, id }) => {
  const [copied, setCopied] = useState(false);

  return (
    <button
      id={id}
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      aria-label={label}
      className="shrink-0 inline-flex items-center justify-center gap-1.5 px-3 min-h-[44px] rounded-xl bg-[#abc4ff] hover:bg-[#b6ccfe] border border-[#c1d3fe] text-xs font-bold text-[#1e293b] transition-colors cursor-pointer"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-emerald-700" /> : <Copy className="w-3.5 h-3.5" />}
      <span>{copied ? 'Copied!' : 'Copy'}</span>
    </button>
  );
};

/**
 * The committee's moderation panel, at `/admin`.
 *
 * WHO CAN SEE THIS IS NOT WHO CAN USE IT. App renders this view only when `user.role` says
 * 'admin', and that check exists purely so the rest of the site is not cluttered with controls
 * a member cannot use. It is NOT a permission boundary: `user.role` arrives in a JSON body and
 * is cached in localStorage, both of which the person in front of the browser controls. Every
 * button below calls an `/api/admin/*` route, and every one of those is gated server-side by
 * `requireAdmin`, which re-reads the role from the database row on each request. A member who
 * forces this panel open sees it render and then watches every action come back 403 NOT_ADMIN,
 * which is exactly the intended outcome -- so do not "strengthen" the client check, and do not
 * let any real authorisation move into it.
 */
export const AdminView: React.FC<AdminViewProps> = ({ user, onClose, onOpenAuctionById }) => {
  /* ---- Open reports ---------------------------------------------------- */
  const [reports, setReports] = useState<AdminReport[]>([]);
  const [isLoadingReports, setIsLoadingReports] = useState(true);
  const [reportsError, setReportsError] = useState<string | null>(null);

  /* ---- Hide a listing -------------------------------------------------- */
  const [hideTarget, setHideTarget] = useState<HideTarget | null>(null);
  const [hideByIdValue, setHideByIdValue] = useState('');
  const [hideNotice, setHideNotice] = useState<string | null>(null);

  /* ---- Ban / unban ----------------------------------------------------- */
  const [banUserId, setBanUserId] = useState('');
  const [banReason, setBanReason] = useState('');
  const [isBanSubmitting, setIsBanSubmitting] = useState(false);
  const [banError, setBanError] = useState<string | null>(null);
  const [banNotice, setBanNotice] = useState<string | null>(null);

  /* ---- Pending password resets ----------------------------------------- */
  // Never loaded on mount, and never polled: see the warning rendered in that section. The
  // admin has to ask for this list explicitly, every time, because asking for it has a cost.
  const [resetRequests, setResetRequests] = useState<AdminResetRequest[] | null>(null);
  const [isLoadingResets, setIsLoadingResets] = useState(false);
  const [resetsError, setResetsError] = useState<string | null>(null);

  const loadReports = useCallback(async () => {
    setIsLoadingReports(true);
    setReportsError(null);

    try {
      const res = await apiFetchAuthed('/api/admin/reports', user.token);
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        setReports([]);
        setReportsError(
          readErrorCode(data) === NOT_ADMIN
            ? 'Your account is not a committee admin, so the reports queue is not available.'
            : describeModerationError(data, 'We could not load the reports queue. Please try again.'),
        );
        return;
      }

      setReports(Array.isArray(data?.reports) ? (data.reports as AdminReport[]) : []);
    } catch (err) {
      console.error('Failed to load reports:', err);
      setReports([]);
      setReportsError('Network error while loading the reports queue. Please try again.');
    } finally {
      setIsLoadingReports(false);
    }
  }, [user.token]);

  useEffect(() => {
    void loadReports();
  }, [loadReports]);

  const loadResetRequests = useCallback(async () => {
    setIsLoadingResets(true);
    setResetsError(null);

    try {
      const res = await apiFetchAuthed('/api/admin/reset-requests', user.token);
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        setResetRequests(null);
        setResetsError(describeModerationError(data, 'We could not load the pending resets.'));
        return;
      }

      setResetRequests(
        Array.isArray(data?.resetRequests) ? (data.resetRequests as AdminResetRequest[]) : [],
      );
    } catch (err) {
      console.error('Failed to load reset requests:', err);
      setResetRequests(null);
      setResetsError('Network error while loading the pending resets. Please try again.');
    } finally {
      setIsLoadingResets(false);
    }
  }, [user.token]);

  const submitBan = async (banned: boolean) => {
    setBanError(null);
    setBanNotice(null);

    const targetId = banUserId.trim();
    if (!targetId) {
      setBanError('Enter the account ID to act on.');
      return;
    }
    if (banned && !banReason.trim()) {
      setBanError('A reason is required to ban an account. It is recorded against the ban.');
      return;
    }

    setIsBanSubmitting(true);

    try {
      const res = await apiFetchAuthed(
        `/api/admin/users/${encodeURIComponent(targetId)}/${banned ? 'ban' : 'unban'}`,
        user.token,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(banned ? { reason: banReason.trim() } : {}),
        },
      );

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        // CANNOT_BAN_SELF and CANNOT_BAN_ADMIN each get their own sentence -- see
        // describeModerationError.
        setBanError(
          describeModerationError(
            data,
            banned ? 'Unable to ban that account. Please try again.' : 'Unable to unban that account. Please try again.',
          ),
        );
        return;
      }

      const name = data?.user?.username ? `@${data.user.username}` : targetId;
      setBanNotice(
        banned
          ? `${name} is banned. They stay signed in but every action now returns "account suspended".`
          : `${name} is unbanned and can use the site again.`,
      );
      setBanReason('');
    } catch (err) {
      console.error('Failed to update ban state:', err);
      setBanError('Network error while updating that account. Please try again.');
    } finally {
      setIsBanSubmitting(false);
    }
  };

  const openReportCount = reports.filter((report) => report.status === 'open').length;

  return (
    <div id="admin-view" className="space-y-6">
      {/* View header */}
      <div className="bg-[#e2eafc] border border-[#ccdbfd] rounded-2xl p-4 sm:p-5 shadow-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg sm:text-2xl font-black text-[#1e293b] tracking-tight flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 shrink-0" />
              <span>Committee Admin</span>
            </h2>
            <p className="text-xs sm:text-sm text-[#1e293b]/75 mt-1">
              Reports, takedowns, bans and password resets. Every action here is recorded against
              your account.
            </p>
          </div>

          <button
            id="admin-back-btn"
            type="button"
            onClick={onClose}
            className="shrink-0 inline-flex items-center justify-center gap-1.5 px-3.5 py-2 min-h-[44px] rounded-xl bg-[#abc4ff] hover:bg-[#b6ccfe] border border-[#c1d3fe] text-[#1e293b] text-sm font-bold shadow-xs transition-colors cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Back to Auctions</span>
          </button>
        </div>
      </div>

      {/* ---------------- Open reports ---------------- */}
      <section id="admin-section-reports" aria-labelledby="admin-reports-heading" className={sectionClass}>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h3
            id="admin-reports-heading"
            className="text-base sm:text-lg font-black tracking-tight text-[#1e293b] flex items-center gap-2"
          >
            <Flag className="w-4 h-4 text-red-600" />
            <span>Open Reports</span>
            <span
              data-testid="admin-open-report-count"
              className="px-2 py-0.5 rounded-md text-[11px] font-bold bg-[#b6ccfe] text-[#1e293b] border border-[#c1d3fe]"
            >
              {openReportCount}
            </span>
          </h3>

          <button
            id="admin-refresh-reports-btn"
            type="button"
            onClick={() => void loadReports()}
            aria-label="Refresh the reports queue"
            className="inline-flex items-center justify-center p-2.5 min-h-[44px] min-w-[44px] rounded-xl bg-[#d7e3fc] hover:bg-[#c1d3fe] border border-[#ccdbfd] text-[#1e293b] transition-colors cursor-pointer"
          >
            <RefreshCw className={`w-4 h-4 ${isLoadingReports ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {hideNotice && (
          <div
            id="admin-hide-notice"
            role="status"
            className="p-2.5 rounded-xl bg-emerald-100/95 border border-emerald-200 text-emerald-900 text-xs flex items-start gap-2"
          >
            <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{hideNotice}</span>
          </div>
        )}

        {reportsError && (
          <div
            id="admin-reports-error"
            role="alert"
            className="p-2.5 rounded-xl bg-red-100/95 border border-red-200 text-red-800 text-xs flex items-center gap-2"
          >
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{reportsError}</span>
          </div>
        )}

        {isLoadingReports ? (
          <div className="py-12 text-center">
            <RefreshCw className="w-6 h-6 mx-auto animate-spin text-[#abc4ff] mb-2" />
            <p className="text-sm font-bold text-[#1e293b]">Loading the reports queue...</p>
          </div>
        ) : reports.length === 0 ? (
          <p className="py-8 text-center text-xs font-semibold text-[#1e293b]/70 bg-[#d7e3fc] border border-[#ccdbfd] rounded-2xl px-4">
            Nothing reported. When a student reports a listing it appears here.
          </p>
        ) : (
          <ul className="space-y-3">
            {reports.map((report) => (
              <li
                key={report.id}
                data-testid={`admin-report-${report.id}`}
                className="p-3 rounded-2xl bg-[#d7e3fc] border border-[#ccdbfd] space-y-2.5"
              >
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2 flex-wrap min-w-0">
                    <span className="px-2 py-0.5 rounded-md text-[11px] font-extrabold bg-red-600 text-white">
                      {reportReasonLabel(report.reason)}
                    </span>
                    {report.status !== 'open' && (
                      <span className="px-2 py-0.5 rounded-md text-[11px] font-bold bg-[#edf2fb] border border-[#ccdbfd] text-[#1e293b]/70 uppercase">
                        {report.status}
                      </span>
                    )}
                  </div>
                  <span className="text-[11px] text-[#1e293b]/70 font-semibold shrink-0">
                    Filed {formatDateTime(report.createdAt)}
                  </span>
                </div>

                <div className="space-y-1">
                  <p className="text-sm font-bold text-[#1e293b] break-words">
                    {report.auctionTitle ?? `Listing ${report.auctionId}`}
                  </p>
                  <p className="text-[11px] text-[#1e293b]/75">
                    Seller: <span className="font-bold">{report.sellerName ?? 'unknown'}</span>
                    {report.sellerId && <span className="font-mono"> ({report.sellerId})</span>}
                  </p>
                  <p className="text-[11px] text-[#1e293b]/75">
                    Reported by <span className="font-mono">{report.reporterId}</span>
                  </p>
                </div>

                {report.details && (
                  <p className="p-2.5 rounded-xl bg-[#edf2fb] border border-[#ccdbfd] text-xs text-[#1e293b] break-words">
                    {report.details}
                  </p>
                )}

                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    type="button"
                    onClick={() => onOpenAuctionById(report.auctionId)}
                    aria-label={`Open the reported listing ${report.auctionTitle ?? report.auctionId}`}
                    className="inline-flex items-center justify-center gap-1.5 px-3 min-h-[44px] rounded-xl bg-[#edf2fb] hover:bg-[#c1d3fe] border border-[#ccdbfd] text-xs font-bold text-[#1e293b] transition-colors cursor-pointer"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>View Listing</span>
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      setHideTarget({ auctionId: report.auctionId, auctionTitle: report.auctionTitle })
                    }
                    aria-label={`Hide the listing ${report.auctionTitle ?? report.auctionId}`}
                    className="inline-flex items-center justify-center gap-1.5 px-3 min-h-[44px] rounded-xl bg-red-600 hover:bg-red-700 text-xs font-extrabold text-white transition-colors cursor-pointer"
                  >
                    <EyeOff className="w-3.5 h-3.5" />
                    <span>Hide Listing</span>
                  </button>

                  {report.sellerId && (
                    <button
                      type="button"
                      onClick={() => {
                        setBanUserId(report.sellerId as string);
                        setBanError(null);
                        setBanNotice(null);
                        document.getElementById('admin-ban-user-id-input')?.focus();
                      }}
                      aria-label={`Load the seller ${report.sellerName ?? report.sellerId} into the ban form`}
                      className="inline-flex items-center justify-center gap-1.5 px-3 min-h-[44px] rounded-xl bg-[#edf2fb] hover:bg-[#c1d3fe] border border-[#ccdbfd] text-xs font-bold text-[#1e293b] transition-colors cursor-pointer"
                    >
                      <Ban className="w-3.5 h-3.5" />
                      <span>Ban Seller...</span>
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---------------- Hide a listing by ID ---------------- */}
      <section id="admin-section-hide" aria-labelledby="admin-hide-heading" className={sectionClass}>
        <h3
          id="admin-hide-heading"
          className="text-base sm:text-lg font-black tracking-tight text-[#1e293b] flex items-center gap-2"
        >
          <EyeOff className="w-4 h-4 text-red-600" />
          <span>Hide a Listing</span>
        </h3>
        <p className="text-xs text-[#1e293b]/75">
          Hiding removes a listing from the public grid. Reported listings can be hidden from the
          queue above; use this for one nobody has reported yet.
        </p>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-end gap-2">
          <div className="flex-1 min-w-0">
            <label htmlFor="admin-hide-auction-id-input" className="block text-xs font-bold text-[#1e293b] mb-1">
              Listing ID
            </label>
            <input
              id="admin-hide-auction-id-input"
              type="text"
              value={hideByIdValue}
              onChange={(e) => setHideByIdValue(e.target.value)}
              placeholder="e.g. auc_1731000000000_ab12"
              className={inputClass}
            />
          </div>
          <button
            id="admin-hide-by-id-btn"
            type="button"
            disabled={!hideByIdValue.trim()}
            onClick={() => setHideTarget({ auctionId: hideByIdValue.trim(), auctionTitle: null })}
            className="shrink-0 inline-flex items-center justify-center gap-1.5 px-4 min-h-[44px] rounded-xl bg-[#d7e3fc] hover:bg-[#c1d3fe] border border-[#ccdbfd] text-xs font-bold text-[#1e293b] transition-colors disabled:opacity-50 cursor-pointer"
          >
            <EyeOff className="w-3.5 h-3.5" />
            <span>Review &amp; Hide</span>
          </button>
        </div>
      </section>

      {/* ---------------- Ban / unban ---------------- */}
      <section id="admin-section-ban" aria-labelledby="admin-ban-heading" className={sectionClass}>
        <h3
          id="admin-ban-heading"
          className="text-base sm:text-lg font-black tracking-tight text-[#1e293b] flex items-center gap-2"
        >
          <Ban className="w-4 h-4 text-red-600" />
          <span>Ban or Unban an Account</span>
        </h3>
        <p className="text-xs text-[#1e293b]/75">
          A banned account keeps its session but is refused on every action, with the reason shown
          to them. You cannot ban yourself, and admin accounts cannot be banned from here.
        </p>

        <div>
          <label htmlFor="admin-ban-user-id-input" className="block text-xs font-bold text-[#1e293b] mb-1">
            Account ID
          </label>
          <input
            id="admin-ban-user-id-input"
            type="text"
            value={banUserId}
            onChange={(e) => {
              setBanUserId(e.target.value);
              setBanError(null);
            }}
            placeholder="e.g. usr_1731000000000_ab12"
            className={inputClass}
          />
        </div>

        <div>
          <label htmlFor="admin-ban-reason-input" className="block text-xs font-bold text-[#1e293b] mb-1">
            Reason <span className="font-medium text-[#1e293b]/60">(required to ban)</span>
          </label>
          <textarea
            id="admin-ban-reason-input"
            rows={2}
            maxLength={MODERATION_REASON_MAX_LENGTH}
            value={banReason}
            onChange={(e) => {
              setBanReason(e.target.value);
              setBanError(null);
            }}
            placeholder="e.g. repeated scam listings after a warning"
            className="w-full px-3 py-2 text-sm rounded-xl bg-[#edf2fb] border border-[#ccdbfd] focus:border-[#abc4ff] focus:outline-hidden text-[#1e293b] placeholder-[#1e293b]/40 font-medium resize-y"
          />
        </div>

        {banError && (
          <div
            id="admin-ban-error"
            role="alert"
            className="p-2.5 rounded-xl bg-red-100/95 border border-red-200 text-red-800 text-xs flex items-center gap-2"
          >
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{banError}</span>
          </div>
        )}

        {banNotice && (
          <div
            id="admin-ban-notice"
            role="status"
            className="p-2.5 rounded-xl bg-emerald-100/95 border border-emerald-200 text-emerald-900 text-xs flex items-start gap-2"
          >
            <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{banNotice}</span>
          </div>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          <button
            id="admin-ban-btn"
            type="button"
            disabled={isBanSubmitting}
            onClick={() => void submitBan(true)}
            className="inline-flex items-center justify-center gap-1.5 px-4 min-h-[44px] rounded-xl bg-red-600 hover:bg-red-700 text-xs font-extrabold text-white transition-colors disabled:opacity-60 cursor-pointer"
          >
            <Ban className="w-3.5 h-3.5" />
            <span>{isBanSubmitting ? 'Working...' : 'Ban Account'}</span>
          </button>

          <button
            id="admin-unban-btn"
            type="button"
            disabled={isBanSubmitting}
            onClick={() => void submitBan(false)}
            className="inline-flex items-center justify-center gap-1.5 px-4 min-h-[44px] rounded-xl bg-[#d7e3fc] hover:bg-[#c1d3fe] border border-[#ccdbfd] text-xs font-bold text-[#1e293b] transition-colors disabled:opacity-60 cursor-pointer"
          >
            <UserCheck className="w-3.5 h-3.5" />
            <span>Unban Account</span>
          </button>
        </div>
      </section>

      {/* ---------------- Pending password resets ---------------- */}
      <section id="admin-section-resets" aria-labelledby="admin-resets-heading" className={sectionClass}>
        <h3
          id="admin-resets-heading"
          className="text-base sm:text-lg font-black tracking-tight text-[#1e293b] flex items-center gap-2"
        >
          <KeyRound className="w-4 h-4 text-[#1e293b]" />
          <span>Pending Password Resets</span>
        </h3>

        {/* Rendered BEFORE the list is ever fetched, and kept on screen afterwards. Loading this
            list is not a read -- the server re-mints every pending token to answer it, because
            only the hash is stored. An admin who does not know that will hand out a link, refresh
            the page, and quietly break the link they just sent. Hence: no auto-load on mount, no
            polling, and an explicit button under this warning. */}
        <div
          id="admin-reset-token-warning"
          role="note"
          className="p-3 rounded-xl bg-amber-100/90 border border-amber-300 text-amber-900 text-xs flex items-start gap-2"
        >
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-extrabold">Read this before you load the list.</p>
            <p>
              Loading it <strong>issues a brand new link for every pending request</strong>. Any
              link you handed out earlier stops working the moment you load this, and the
              60-minute expiry starts again from that point. Load it once, send the links, and do
              not refresh until you need new ones.
            </p>
            <p>
              Email delivery is not set up yet, so these links have to reach the student some
              other way — message them yourself.
            </p>
          </div>
        </div>

        {resetsError && (
          <div
            id="admin-resets-error"
            role="alert"
            className="p-2.5 rounded-xl bg-red-100/95 border border-red-200 text-red-800 text-xs flex items-center gap-2"
          >
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{resetsError}</span>
          </div>
        )}

        <button
          id="admin-load-resets-btn"
          type="button"
          disabled={isLoadingResets}
          onClick={() => void loadResetRequests()}
          className="inline-flex items-center justify-center gap-1.5 px-4 min-h-[44px] rounded-xl bg-[#abc4ff] hover:bg-[#b6ccfe] border border-[#c1d3fe] text-xs font-extrabold text-[#1e293b] transition-colors disabled:opacity-60 cursor-pointer"
        >
          <KeyRound className="w-3.5 h-3.5" />
          <span>
            {isLoadingResets
              ? 'Issuing new links...'
              : resetRequests === null
              ? 'Load pending resets (issues new links)'
              : 'Re-issue links and reload'}
          </span>
        </button>

        {resetRequests !== null &&
          (resetRequests.length === 0 ? (
            <p
              id="admin-resets-empty"
              className="py-8 text-center text-xs font-semibold text-[#1e293b]/70 bg-[#d7e3fc] border border-[#ccdbfd] rounded-2xl px-4"
            >
              Nobody has a pending password reset right now.
            </p>
          ) : (
            <ul className="space-y-3">
              {resetRequests.map((request) => {
                const link = `${typeof window !== 'undefined' ? window.location.origin : ''}/reset-password?token=${encodeURIComponent(request.token)}`;
                const remaining = formatTimeRemaining(request.expiresAt);

                return (
                  <li
                    key={request.userId}
                    data-testid={`admin-reset-${request.userId}`}
                    className="p-3 rounded-2xl bg-[#d7e3fc] border border-[#ccdbfd] space-y-2.5"
                  >
                    <div className="flex items-start justify-between gap-2 flex-wrap">
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-[#1e293b] break-words">
                          {request.name} <span className="font-medium text-[#1e293b]/70">@{request.username}</span>
                        </p>
                        <p className="text-[11px] text-[#1e293b]/75 break-all">
                          {request.email ?? 'No email on file'}
                        </p>
                      </div>
                      <span className="text-[11px] font-bold text-[#1e293b]/75 shrink-0">
                        {remaining.isEnded
                          ? 'Expired'
                          : `Expires ${formatDateTime(request.expiresAt)} (in ${remaining.formatted})`}
                      </span>
                    </div>

                    <div className="flex items-center gap-2 flex-wrap">
                      <code className="flex-1 min-w-0 px-2.5 py-2 rounded-xl bg-[#edf2fb] border border-[#ccdbfd] text-[11px] text-[#1e293b] break-all">
                        {link}
                      </code>
                      <CopyButton
                        id={`admin-copy-reset-${request.userId}`}
                        value={link}
                        label={`Copy the reset link for @${request.username}`}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          ))}
      </section>

      {hideTarget && (
        <HideListingModal
          auctionId={hideTarget.auctionId}
          auctionTitle={hideTarget.auctionTitle}
          user={user}
          onClose={() => setHideTarget(null)}
          onHidden={({ reportsActioned }) => {
            setHideTarget(null);
            setHideByIdValue('');
            setHideNotice(
              reportsActioned > 0
                ? `Listing hidden. ${reportsActioned} open ${reportsActioned === 1 ? 'report was' : 'reports were'} closed with it.`
                : 'Listing hidden. It is no longer on the public grid.',
            );
            // The hide closed that listing's open reports server-side, so the queue on screen is
            // now stale by exactly those rows. Refetch rather than patch locally: the server is
            // the one that decided which reports were actioned.
            void loadReports();
          }}
        />
      )}
    </div>
  );
};
