import type { ReactNode } from "react";
import { useData } from "../data.tsx";
import { useToast } from "../toast.tsx";
import { EVENT_TYPE_OPTIONS, isPending, tripStage } from "../lib/events.ts";
import type { Route } from "../lib/router.ts";
import { BellIcon, HistoryIcon, HomeIcon, LifebuoyIcon, PlusIcon, RefreshIcon, WalletIcon } from "../icons.tsx";

/**
 * The three-column frame from the Figma: filters and page tools on the left,
 * the working area in the middle, and the main actions on the right. On
 * narrow screens the rails fold into a top bar and a bottom bar.
 */
export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  const { trips, unreadCount, refresh } = useData();
  const toast = useToast();
  const section = route.segments[0] ?? "";
  const onEvents = section === "" || section === "event";
  const activeType = section === "" ? route.query.get("type") : null;

  const counts = new Map<string, number>();
  let pending = 0;
  for (const t of trips) {
    if (isPending(tripStage(t))) pending += 1;
    const key = t.eventType ?? "other";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return (
    <div className="frame">
      <a className="skip" href="#main">
        Skip to content
      </a>

      <aside className="rail rail-left" aria-label="Trip Agent">
        <a className="brand" href="#/">
          <span className="brand-mark" aria-hidden="true" />
          Trip Agent
        </a>

        <div className="rail-tools">
          <button type="button" className="chip" onClick={() => void refresh().then(() => toast("Events are up to date."))}>
            <RefreshIcon size={16} /> Refresh page
          </button>
          <a className="chip" href="#/" aria-current={section === "" && !activeType ? "page" : undefined}>
            <HomeIcon size={16} /> Main menu
          </a>
        </div>

        {onEvents && (
          <nav className="filters" aria-label="Event types">
            <a className="chip chip-filter" href="#/" aria-current={section === "" && !activeType ? "page" : undefined}>
              All events <span className="count">{trips.length}</span>
            </a>
            {EVENT_TYPE_OPTIONS.map((o) => (
              <a
                key={o.value}
                className="chip chip-filter"
                href={`#/?type=${o.value}`}
                aria-current={activeType === o.value ? "page" : undefined}
              >
                {o.filter} <span className="count">{counts.get(o.value) ?? 0}</span>
              </a>
            ))}
          </nav>
        )}
      </aside>

      <main id="main" className="stage" tabIndex={-1}>
        {children}
      </main>

      <nav className="rail rail-right" aria-label="Main actions">
        <a className="act act-primary" href="#/new" aria-current={section === "new" ? "page" : undefined}>
          <span>Plan New Event</span>
          <PlusIcon size={22} />
        </a>
        <a className="act" href="#/wallet" aria-current={section === "wallet" ? "page" : undefined}>
          <span>Fund Wallet</span>
          <WalletIcon size={22} />
        </a>
        <a className="act" href="#/history" aria-current={section === "history" ? "page" : undefined}>
          <span>History</span>
          <HistoryIcon size={22} />
        </a>
        <a className="act" href="#/notifications" aria-current={section === "notifications" ? "page" : undefined}>
          <span>Notifications</span>
          <span className="act-icon">
            <BellIcon size={22} />
            {unreadCount > 0 && (
              <span className="badge-dot" aria-label={`${unreadCount} unread`}>
                {unreadCount > 9 ? "9+" : unreadCount}
              </span>
            )}
          </span>
        </a>
        <a className="act" href="#/support" aria-current={section === "support" ? "page" : undefined}>
          <span>Support</span>
          <LifebuoyIcon size={22} />
        </a>
        {pending > 0 && (
          <p className="rail-note">
            {pending} pending {pending === 1 ? "event" : "events"}
          </p>
        )}
      </nav>
    </div>
  );
}
