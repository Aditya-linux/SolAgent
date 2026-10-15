import { useState } from "react";
import type { TripSummary } from "@solagent/api";
import { api } from "../api.ts";
import { useData } from "../data.tsx";
import { useToast } from "../toast.tsx";
import { BudgetRoute, Banner, EmptyState, Ribbon, StatusPill } from "../components/bits.tsx";
import { EVENT_TYPE_OPTIONS, compareEvents, eventTypeLabel, isEventType, tripStage, tripTitle } from "../lib/events.ts";
import { errorMessage, formatDateRange, formatUsd, plural } from "../lib/format.ts";
import { describeOutcomes } from "../lib/outcomes.ts";
import { eventHref, type Route } from "../lib/router.ts";

export function Dashboard({ route }: { route: Route }) {
  const { trips, loading, error, refresh } = useData();
  const typeParam = route.query.get("type");
  const filter = isEventType(typeParam) ? typeParam : null;
  const filterName = EVENT_TYPE_OPTIONS.find((o) => o.value === filter)?.filter;

  const shown = trips.filter((t) => !filter || t.eventType === filter).sort(compareEvents);
  const open = shown.filter((t) => tripStage(t).key !== "booked" && tripStage(t).key !== "empty");
  const done = shown.filter((t) => !open.includes(t));

  return (
    <>
      <Ribbon>{filterName ? `${filterName}` : "Pending Events"}</Ribbon>

      {error && (
        <Banner
          tone="error"
          action={
            <button type="button" className="btn btn-light" onClick={() => void refresh()}>
              Try again
            </button>
          }
        >
          Can't reach the Trip Agent API. Check that <code>npm run dev</code> is running in the project folder, then try again.
        </Banner>
      )}

      {loading && !error && <p className="status-line">Loading your events…</p>}

      {!loading && !error && trips.length === 0 && (
        <EmptyState
          title="No events yet"
          action={
            <a className="btn btn-yellow" href="#/new">
              Plan your first event
            </a>
          }
        >
          Tell the agent where you want to go and what you can spend. It picks flights, a place to stay and things to do, and you approve each booking.
        </EmptyState>
      )}

      {!loading && !error && trips.length > 0 && shown.length === 0 && (
        <EmptyState
          title={`No ${filterName?.toLowerCase() ?? "matching"} events`}
          action={
            <a className="btn btn-yellow" href="#/">
              Show all events
            </a>
          }
        >
          Events you plan as {filter ? eventTypeLabel(filter).toLowerCase() : "this type"} will show up here.
        </EmptyState>
      )}

      <ul className="tickets">
        {open.map((t) => (
          <TicketRow key={t.id} trip={t} />
        ))}
      </ul>

      {done.length > 0 && (
        <>
          <h2 className="section-title">Booked and finished</h2>
          <ul className="tickets">
            {done.map((t) => (
              <TicketRow key={t.id} trip={t} />
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function TicketRow({ trip }: { trip: TripSummary }) {
  const toast = useToast();
  const { refresh } = useData();
  const [busy, setBusy] = useState<"approve" | "refresh" | null>(null);
  const stage = tripStage(trip);
  const title = tripTitle(trip);
  const open = trip.items.proposed + trip.items.approved;

  async function approve() {
    setBusy("approve");
    try {
      const { outcomes } = await api.approveAll(trip.id);
      const result = describeOutcomes(outcomes);
      toast(result.message, result.tone);
      await refresh();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(null);
    }
  }

  async function refreshPrices() {
    setBusy("refresh");
    try {
      const { changes } = await api.refreshPrices(trip.id);
      toast(changes.length === 0 ? "Prices are unchanged." : `Prices changed on ${plural(changes.length, "item")}. The plan was updated.`, changes.length === 0 ? "info" : "warning");
      await refresh();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="ticket">
      <div className="ticket-stub" aria-hidden="true">
        <span className="ticket-code">{trip.destination.toUpperCase()}</span>
        <span className="ticket-kind">{eventTypeLabel(trip.eventType)}</span>
      </div>
      <div className="ticket-body">
        <div className="ticket-head">
          <h3>
            <a href={eventHref(trip.id)} className="ticket-link">
              {title}
            </a>
          </h3>
          <StatusPill tone={stage.tone}>{stage.label}</StatusPill>
        </div>
        <p className="ticket-meta">
          {formatDateRange(trip.startDate, trip.endDate)}
          {trip.origin ? `, from ${trip.origin.toUpperCase()}` : ""} for {plural(trip.travelers, "traveler")}
          {stage.detail ? `. ${stage.detail}${stage.key === "signature" ? " waiting" : ""}` : ""}
        </p>

        <BudgetRoute paid={trip.paidCents} planned={trip.plannedCents} cap={trip.budgetCents} compact />

        <div className="ticket-actions">
          {open > 0 && stage.key !== "signature" && (
            <button type="button" className="btn btn-ink" onClick={approve} disabled={busy !== null}>
              {busy === "approve" ? "Approving…" : `Approve ${open > 1 ? `all ${open}` : ""}`.trim()}
            </button>
          )}
          {stage.key === "signature" && (
            <a className="btn btn-ink" href={eventHref(trip.id)}>
              Review and sign
            </a>
          )}
          <button type="button" className="btn btn-light" onClick={refreshPrices} disabled={busy !== null || trip.items.booked + open === 0}>
            {busy === "refresh" ? "Checking…" : "Refresh prices"}
          </button>
          <a className="btn btn-light" href={`${eventHref(trip.id)}?view=expenses`}>
            Expenses
          </a>
          {trip.openBookingsCents > 0 && <span className="ticket-open">{formatUsd(trip.openBookingsCents)} waiting to be booked</span>}
        </div>
      </div>
    </li>
  );
}
