import { useMemo, useState } from "react";
import { Banner, EmptyState, Ribbon } from "../components/bits.tsx";
import { eventGroup, tripTitle, type EventGroup } from "../lib/events.ts";
import { dayHeading, dayKey, timeOfDay } from "../lib/format.ts";
import { summarizeForView } from "../lib/tripView.ts";
import { eventHref } from "../lib/router.ts";
import { useAllTrips } from "./useAllTrips.ts";

const FILTERS: Array<{ value: EventGroup | "all"; label: string }> = [
  { value: "all", label: "Everything" },
  { value: "bookings", label: "Bookings" },
  { value: "payments", label: "Payments" },
  { value: "changes", label: "Plan changes" },
];

export function History() {
  const { trips, error, ready } = useAllTrips();
  const [filter, setFilter] = useState<EventGroup | "all">("all");

  const days = useMemo(() => {
    const rows = trips.flatMap((trip) => {
      const title = tripTitle(summarizeForView(trip));
      return trip.events.map((e) => ({ ...e, title }));
    });
    const kept = rows.filter((r) => filter === "all" || eventGroup(r.type) === filter).sort((a, b) => b.at.localeCompare(a.at));
    const byDay = new Map<string, typeof kept>();
    for (const r of kept) byDay.set(dayKey(r.at), [...(byDay.get(dayKey(r.at)) ?? []), r]);
    return [...byDay.values()];
  }, [trips, filter]);

  return (
    <>
      <Ribbon>History</Ribbon>
      <div className="seg seg-wrap seg-bar" role="radiogroup" aria-label="Show">
        {FILTERS.map((f) => (
          <label key={f.value} className={filter === f.value ? "seg-on" : undefined}>
            <input type="radio" name="history" checked={filter === f.value} onChange={() => setFilter(f.value)} />
            {f.label}
          </label>
        ))}
      </div>
      {error && <Banner tone="error">{error}</Banner>}
      {!ready && !error && <p className="status-line">Loading history…</p>}
      {ready && !error && days.length === 0 && (
        <EmptyState title="Nothing here yet">Bookings, payments and plan changes show up here as the agent works.</EmptyState>
      )}
      {days.map((rows) => (
        <section key={dayKey(rows[0]!.at)} className="panel" aria-label={dayHeading(rows[0]!.at)}>
          <h2>{dayHeading(rows[0]!.at)}</h2>
          <ol className="log">
            {rows.map((r) => (
              <li key={r.id}>
                <time dateTime={r.at}>{timeOfDay(r.at)}</time>
                <span>
                  {r.message} <a href={eventHref(r.tripId)}>{r.title}</a>
                </span>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </>
  );
}
