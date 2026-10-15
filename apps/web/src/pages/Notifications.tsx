import { useEffect, useMemo } from "react";
import { useData } from "../data.tsx";
import { Banner, EmptyState, Ribbon, StatusPill } from "../components/bits.tsx";
import { isAlert, tripTitle } from "../lib/events.ts";
import { timeAgo } from "../lib/format.ts";
import { summarizeForView } from "../lib/tripView.ts";
import { eventHref } from "../lib/router.ts";
import { useAllTrips } from "./useAllTrips.ts";

export function Notifications() {
  const { trips, error, ready } = useAllTrips();
  const { markAlertsSeen } = useData();

  // Opening the page counts as reading the alerts. Signatures stay until they're signed.
  useEffect(() => {
    if (ready) markAlertsSeen();
  }, [ready, markAlertsSeen]);

  const { signatures, alerts } = useMemo(() => {
    const signatures: Array<{ tripId: string; title: string; itemTitle: string }> = [];
    const alerts: Array<{ id: string; tripId: string; title: string; message: string; at: string }> = [];
    for (const trip of trips) {
      const title = tripTitle(summarizeForView(trip));
      for (const itemId of Object.keys(trip.pendingSignatures)) {
        const item = trip.plan.items.find((i) => i.id === itemId);
        signatures.push({ tripId: trip.id, title, itemTitle: item?.title ?? "A booking" });
      }
      for (const e of trip.events) if (isAlert(e.type)) alerts.push({ id: e.id, tripId: trip.id, title, message: e.message, at: e.at });
    }
    alerts.sort((a, b) => b.at.localeCompare(a.at));
    return { signatures, alerts: alerts.slice(0, 30) };
  }, [trips]);

  return (
    <>
      <Ribbon>Notifications</Ribbon>
      {error && <Banner tone="error">{error}</Banner>}
      {!ready && !error && <p className="status-line">Loading notifications…</p>}
      {ready && !error && signatures.length === 0 && alerts.length === 0 && (
        <EmptyState title="You're all caught up">Price changes, failed bookings and payments waiting for you will show up here.</EmptyState>
      )}

      {signatures.length > 0 && (
        <section className="panel" aria-labelledby="sig-h">
          <h2 id="sig-h">Waiting for your signature</h2>
          <ul className="notes">
            {signatures.map((s) => (
              <li key={`${s.tripId}-${s.itemTitle}`}>
                <StatusPill tone="yellow">Sign</StatusPill>
                <span>
                  {s.itemTitle} in {s.title}
                </span>
                <a className="btn btn-small btn-ink" href={eventHref(s.tripId)}>
                  Review and sign
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {alerts.length > 0 && (
        <section className="panel" aria-labelledby="alerts-h">
          <h2 id="alerts-h">Heads-up</h2>
          <ul className="notes">
            {alerts.map((a) => (
              <li key={a.id}>
                <StatusPill tone="red">Alert</StatusPill>
                <span>
                  {a.message} <a href={eventHref(a.tripId)}>{a.title}</a>
                </span>
                <time className="when">{timeAgo(a.at)}</time>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
