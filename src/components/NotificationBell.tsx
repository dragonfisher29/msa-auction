import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bell, ShieldAlert, Trophy, Gavel, PoundSterling, CheckCheck, BellOff } from 'lucide-react';
import { AppNotification, NotificationType, User } from '../types';
import { apiFetchAuthed } from '../lib/api';
import { startPolling } from '../lib/realtime';
import { formatCurrencyPrecise, formatTimeRemaining } from '../lib/formatters';
import {
  loadReadNotificationIds,
  saveReadNotificationIds,
} from '../lib/notificationStorage';

// Header-level feed, polled on the same cadence as the other header-level poller (the health
// ping in App.tsx). The 5s auction feed is the grid's cadence; a badge does not need it.
const POLL_INTERVAL_MS = 15000;

interface NotificationBellProps {
  /** Always a signed-in user: the Header does not mount this component when signed out, so
   *  no request is ever made for an anonymous visitor. */
  user: User;
  onOpenAuction: (auctionId: string) => void;
}

const TYPE_ICON: Record<NotificationType, React.ComponentType<{ className?: string }>> = {
  outbid: ShieldAlert,
  won: Trophy,
  lost: Gavel,
  sold: PoundSterling,
};

const TYPE_ACCENT: Record<NotificationType, string> = {
  outbid: 'bg-amber-100 text-amber-700 border-amber-300',
  won: 'bg-emerald-100 text-emerald-700 border-emerald-300',
  lost: 'bg-[#d7e3fc] text-[#1e293b] border-[#ccdbfd]',
  sold: 'bg-emerald-100 text-emerald-700 border-emerald-300',
};

function describe(notification: AppNotification): { headline: string; detail: string } {
  const amount = formatCurrencyPrecise(notification.amount);

  switch (notification.type) {
    case 'outbid':
      return {
        headline: `You were outbid on ${notification.auctionTitle}`,
        detail: `The leading bid is now ${amount}.`,
      };
    case 'won':
      return {
        headline: `You won ${notification.auctionTitle}`,
        detail: `Winning bid ${amount}. Open it to get the seller's contact details.`,
      };
    case 'lost':
      return {
        headline: `${notification.auctionTitle} ended without you`,
        detail: `It closed at ${amount}.`,
      };
    case 'sold':
      return {
        headline: `Your listing ${notification.auctionTitle} sold`,
        detail: `Final bid ${amount}.`,
      };
  }
}

// Relative label built from formatTimeRemaining's own unit breakdown rather than a second
// implementation of time maths: mirroring a past timestamp into the future (now + elapsed)
// makes the shared helper return the elapsed hours/minutes, which is all this needs.
function relativeLabel(timestamp: number): string {
  const now = Date.now();
  const elapsed = formatTimeRemaining(now + (now - timestamp));

  if (elapsed.hours > 0) {
    return `${elapsed.hours}h ago`;
  }
  if (elapsed.minutes > 0) {
    return `${elapsed.minutes}m ago`;
  }
  return 'Just now';
}

export const NotificationBell: React.FC<NotificationBellProps> = ({ user, onOpenAuction }) => {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [readIds, setReadIds] = useState<string[]>(() => loadReadNotificationIds(user.id));
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  // True once the endpoint answers 404: the backend has not shipped it yet, so the panel says
  // so calmly instead of rendering a red failure the user can do nothing about.
  const [isUnavailable, setIsUnavailable] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);

  const fetchNotifications = useCallback(async (): Promise<AppNotification[] | null> => {
    const res = await apiFetchAuthed('/api/notifications', user.token);

    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`Notifications responded with ${res.status}`);
    }

    const data = await res.json();
    return Array.isArray(data) ? (data as AppNotification[]) : [];
  }, [user.token]);

  const applyResult = useCallback((next: AppNotification[] | null) => {
    if (next === null) {
      setIsUnavailable(true);
      setNotifications([]);
      return;
    }
    setIsUnavailable(false);
    setNotifications(next);

    // The server caps the feed at 50 and ids are stable, so a read id that has aged out of it
    // is gone for good. Prune it here rather than growing this list in localStorage forever.
    const liveIds = new Set(next.map((n) => n.id));
    setReadIds((prev) => {
      const pruned = prev.filter((id) => liveIds.has(id));
      if (pruned.length === prev.length) {
        return prev;
      }
      saveReadNotificationIds(user.id, pruned);
      return pruned;
    });
  }, [user.id]);

  // Initial load: the poller's first tick only fires after the interval, exactly as the
  // auction feed in App.tsx does its own first fetch.
  useEffect(() => {
    let isActive = true;

    (async () => {
      try {
        const data = await fetchNotifications();
        if (isActive) {
          applyResult(data);
        }
      } catch (err) {
        console.warn('[Notifications] Initial load failed:', err);
      } finally {
        if (isActive) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      isActive = false;
    };
  }, [fetchNotifications, applyResult]);

  // Live feed: same polling helper as the auction list, so it pauses with the tab and never
  // overlaps requests.
  useEffect(() => {
    return startPolling<AppNotification[] | null>(fetchNotifications, POLL_INTERVAL_MS, applyResult);
  }, [fetchNotifications, applyResult]);

  // Close the panel on Escape or a click outside it.
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const readIdSet = useMemo(() => new Set(readIds), [readIds]);
  const unreadCount = notifications.filter((n) => !readIdSet.has(n.id)).length;

  const markRead = (ids: string[]) => {
    setReadIds((prev) => {
      const next = Array.from(new Set([...prev, ...ids]));
      saveReadNotificationIds(user.id, next);
      return next;
    });
  };

  const handleSelect = (notification: AppNotification) => {
    markRead([notification.id]);
    setIsOpen(false);
    onOpenAuction(notification.auctionId);
  };

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        id="notifications-toggle-btn"
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-label={
          unreadCount > 0
            ? `Notifications, ${unreadCount} unread`
            : 'Notifications, none unread'
        }
        aria-expanded={isOpen}
        aria-haspopup="true"
        className={`relative inline-flex items-center justify-center p-2 min-h-[44px] min-w-[44px] rounded-xl border transition-colors cursor-pointer ${
          isOpen
            ? 'bg-[#abc4ff] border-[#c1d3fe] text-[#1e293b]'
            : 'bg-[#d7e3fc] hover:bg-[#c1d3fe] border-[#ccdbfd] text-[#1e293b]'
        }`}
      >
        <Bell className="w-4 h-4" />
        {unreadCount > 0 && (
          <span
            data-testid="notification-unread-count"
            aria-hidden="true"
            className="absolute -top-1 -right-1 min-w-[20px] h-5 px-1.5 rounded-full bg-rose-500 text-white text-[11px] font-extrabold flex items-center justify-center border border-[#e2eafc] shadow-xs"
          >
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div
          id="notifications-panel"
          role="region"
          aria-label="Notifications"
          className="absolute right-0 top-full mt-2 w-[min(20rem,calc(100vw-2rem))] max-h-[min(24rem,70vh)] overflow-y-auto overscroll-contain rounded-2xl bg-[#e2eafc] border border-[#ccdbfd] shadow-2xl z-40"
        >
          <div className="sticky top-0 flex items-center justify-between gap-2 px-3 py-2 bg-[#d7e3fc] border-b border-[#ccdbfd]">
            <span className="text-xs font-extrabold uppercase tracking-wider text-[#1e293b]">
              Notifications
            </span>
            {unreadCount > 0 && (
              <button
                id="notifications-mark-all-read-btn"
                type="button"
                onClick={() => markRead(notifications.map((n) => n.id))}
                aria-label="Mark all notifications as read"
                className="inline-flex items-center justify-center gap-1.5 px-2.5 min-h-[44px] rounded-xl bg-[#edf2fb] hover:bg-[#c1d3fe] border border-[#ccdbfd] text-[11px] font-bold text-[#1e293b] transition-colors cursor-pointer"
              >
                <CheckCheck className="w-3.5 h-3.5" />
                <span>Mark all read</span>
              </button>
            )}
          </div>

          {isLoading && notifications.length === 0 ? (
            <p className="px-3 py-8 text-center text-xs font-semibold text-[#1e293b]/70">
              Loading your notifications...
            </p>
          ) : isUnavailable ? (
            <div className="px-3 py-8 text-center">
              <BellOff className="w-6 h-6 mx-auto text-[#1e293b]/45 mb-2" />
              <p className="text-xs font-bold text-[#1e293b]">Notifications are not available yet</p>
              <p className="text-[11px] text-[#1e293b]/70 mt-1">
                Outbid and result alerts will appear here once the feed is live.
              </p>
            </div>
          ) : notifications.length === 0 ? (
            <div className="px-3 py-8 text-center">
              <BellOff className="w-6 h-6 mx-auto text-[#1e293b]/45 mb-2" />
              <p className="text-xs font-bold text-[#1e293b]">You're all caught up</p>
              <p className="text-[11px] text-[#1e293b]/70 mt-1">
                Bid on something and we'll tell you the moment you're outbid.
              </p>
            </div>
          ) : (
            <ul className="p-2 space-y-1.5">
              {notifications.map((notification) => {
                const Icon = TYPE_ICON[notification.type];
                const { headline, detail } = describe(notification);
                const isUnread = !readIdSet.has(notification.id);

                return (
                  <li key={notification.id}>
                    <button
                      id={`notification-item-${notification.id}`}
                      type="button"
                      onClick={() => handleSelect(notification)}
                      className={`w-full min-h-[44px] text-left flex items-start gap-2.5 p-2.5 rounded-xl border transition-colors cursor-pointer ${
                        isUnread
                          ? 'bg-[#d7e3fc] border-[#b6ccfe] hover:bg-[#c1d3fe]'
                          : 'bg-[#edf2fb] border-[#ccdbfd] hover:bg-[#d7e3fc]'
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className={`shrink-0 w-7 h-7 rounded-lg border flex items-center justify-center ${TYPE_ACCENT[notification.type]}`}
                      >
                        <Icon className="w-3.5 h-3.5" />
                      </span>

                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-bold text-[#1e293b] break-words">
                          {headline}
                          {isUnread && <span className="sr-only"> (unread)</span>}
                        </span>
                        <span className="block text-[11px] text-[#1e293b]/75 mt-0.5 break-words">
                          {detail}
                        </span>
                        <span className="block text-[10px] text-[#1e293b]/60 mt-1 font-semibold">
                          {relativeLabel(notification.timestamp)}
                        </span>
                      </span>

                      {isUnread && (
                        <span
                          aria-hidden="true"
                          className="shrink-0 mt-1 w-2 h-2 rounded-full bg-rose-500"
                        ></span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};
