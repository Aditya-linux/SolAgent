import { useEffect, useRef, useState } from "react";
import type { Trip } from "@solagent/api";
import type { Category, PlanItem } from "@solagent/shared";
import { api } from "../api.ts";
import { useData } from "../data.tsx";
import { useTrip } from "../useTrip.ts";
import { useToast } from "../toast.tsx";
import { Banner, BudgetRoute, Modal, Ribbon, StatusPill } from "../components/bits.tsx";
import { CATEGORY_ORDER, categoryLabel, eventTypeLabel, tripStage, tripTitle } from "../lib/events.ts";
import { errorMessage, formatDateRange, formatTripDay, formatUsd, plural, timeOfDay, dayHeading } from "../lib/format.ts";
import { describeOutcomes } from "../lib/outcomes.ts";
import { summarizeForView } from "../lib/tripView.ts";
import { ChevronLeftIcon, PenIcon } from "../icons.tsx";
import type { Route } from "../lib/router.ts";

export function EventDetail({ tripId, route }: { tripId: string; route: Route }) {
  const { trip, error, refetch } = useTrip(tripId);
  const { refresh } = useData();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [signing, setSigning] = useState<PlanItem | null>(null);
  const [showTools, setShowTools] = useState(false);
  const expensesRef = useRef<HTMLElement>(null);

  const wantsExpenses = route.query.get("view") === "expenses";
  useEffect(() => {
    if (trip && wantsExpenses) expensesRef.current?.scrollIntoView({ block: "start" });
  }, [trip, wantsExpenses]);

  async function run(key: string, job: () => Promise<void>) {
    setBusy(key);
    try {
      await job();
      await Promise.all([refetch(), refresh()]);
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(null);
    }
  }

  if (error && !trip) {
    return (
      <>
        <BackLink />
        <Ribbon>Event</Ribbon>
        <Banner tone="error" action={<button type="button" className="btn btn-light" onClick={() => void refetch()}>Try again</button>}>
          {error}
        </Banner>
      </>
    );
  }
  if (!trip) {
    return (
      <>
        <BackLink />
        <Ribbon>Event</Ribbon>
        <p className="status-line">Loading this event…</p>
      </>
    );
  }

  const view = summarizeForView(trip);
  const { plan } = trip;
  const stage = tripStage(view);
  const byCategory = new Map<Category, PlanItem[]>();
  for (const item of plan.items) byCategory.set(item.category, [...(byCategory.get(item.category) ?? []), item]);
  const open = view.items.proposed + view.items.approved;
  const events = [...trip.events].reverse();

  const approveAll = () =>
    run("all", async () => {
      const { outcomes } = await api.approveAll(tripId);
      const r = describeOutcomes(outcomes);
      toast(r.message, r.tone);
    });

  return (
    <>
      <BackLink />
      <Ribbon>{tripTitle(view)}</Ribbon>

      <section className="panel" aria-label="Overview">
        <div className="overview-head">
          <p className="ticket-meta">
            {eventTypeLabel(view.eventType)}. {formatDateRange(view.startDate, view.endDate)}
            {view.origin ? `, from ${view.origin.toUpperCase()}` : ""} for {plural(view.travelers, "traveler")}
          </p>
          <StatusPill tone={stage.tone}>{stage.label}</StatusPill>
        </div>
        <p className="summary">{plan.summary}</p>
        {plan.warnings.map((w, i) => (
          <Banner key={i} tone="warning">
            {w}
          </Banner>
        ))}
        <BudgetRoute paid={view.paidCents} planned={view.plannedCents} cap={view.budgetCents} />
        <div className="ticket-actions">
          {open > 0 && (
            <button type="button" className="btn btn-ink" onClick={approveAll} disabled={busy !== null}>
              {busy === "all" ? "Approving…" : open > 1 ? `Approve all ${open}` : "Approve"}
            </button>
          )}
          <button
            type="button"
            className="btn btn-light"
            disabled={busy !== null}
            onClick={() =>
              run("prices", async () => {
                const { changes } = await api.refreshPrices(tripId);
                toast(changes.length === 0 ? "Prices are unchanged." : `Prices changed on ${plural(changes.length, "item")}. The plan was updated.`, changes.length === 0 ? "info" : "warning");
              })
            }
          >
            {busy === "prices" ? "Checking…" : "Refresh prices"}
          </button>
        </div>
      </section>

      <section className="panel" ref={expensesRef} aria-labelledby="expenses-h">
        <h2 id="expenses-h">Expenses</h2>
        <table className="expenses">
          <thead>
            <tr>
              <th scope="col">Category</th>
              <th scope="col" className="num">Paid</th>
              <th scope="col" className="num">Planned</th>
              <th scope="col" className="num">Cap</th>
            </tr>
          </thead>
          <tbody>
            {CATEGORY_ORDER.map((c) => plan.envelopes.find((e) => e.category === c)).filter((e) => e !== undefined).map((e) => (
              <tr key={e.category} className={e.plannedCents > e.allocatedCents ? "over" : undefined}>
                <th scope="row">{categoryLabel(e.category)}</th>
                <td className="num">{formatUsd(e.committedCents)}</td>
                <td className="num">{formatUsd(e.plannedCents)}</td>
                <td className="num">{formatUsd(e.allocatedCents)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Held back as a buffer</th>
              <td />
              <td />
              <td className="num">{formatUsd(plan.bufferCents)}</td>
            </tr>
          </tfoot>
        </table>
        <p className="fine">Food and local transport are estimates, so they aren't booked. They count toward the plan total.</p>
      </section>

      <section className="panel" aria-labelledby="plan-h">
        <h2 id="plan-h">Itinerary</h2>
        {CATEGORY_ORDER.filter((c) => byCategory.has(c)).map((category) => (
          <div className="group" key={category}>
            <h3>{categoryLabel(category)}</h3>
            <ul className="items">
              {byCategory.get(category)!.map((item) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  tripId={tripId}
                  awaiting={trip.pendingSignatures[item.id] !== undefined}
                  busy={busy === item.id}
                  anyBusy={busy !== null}
                  showTools={showTools}
                  onApprove={() =>
                    run(item.id, async () => {
                      const { outcome } = await api.approveItem(tripId, item.id);
                      if (outcome) {
                        const r = describeOutcomes([outcome]);
                        toast(r.message, r.tone);
                      }
                    })
                  }
                  onSign={() => setSigning(item)}
                  onCancel={() =>
                    run(item.id, async () => {
                      const { refundCents } = await api.cancelItem(tripId, item.id);
                      toast(refundCents > 0 ? `Cancelled. ${formatUsd(refundCents)} refunded.` : "Cancelled.", "success");
                    })
                  }
                  onSimulate={(kind) =>
                    run(item.id, async () => {
                      await api.simulate(tripId, item.id, kind);
                      toast("Test condition set. Approve or refresh prices to see it.", "info");
                    })
                  }
                />
              ))}
            </ul>
          </div>
        ))}
        <label className="check">
          <input type="checkbox" checked={showTools} onChange={(e) => setShowTools(e.target.checked)} />
          Show test tools (simulate a price jump, sold-out or flaky supplier)
        </label>
      </section>

      <section className="panel" aria-labelledby="activity-h">
        <h2 id="activity-h">Activity</h2>
        <ol className="log">
          {events.map((e) => (
            <li key={e.id}>
              <time dateTime={e.at}>
                {dayHeading(e.at)}, {timeOfDay(e.at)}
              </time>
              <span>{e.message}</span>
            </li>
          ))}
        </ol>
      </section>

      <SignModal
        item={signing}
        trip={trip}
        busy={busy === signing?.id}
        onClose={() => setSigning(null)}
        onConfirm={() => {
          const item = signing;
          if (!item) return;
          void run(item.id, async () => {
            const { outcome } = await api.signPayment(tripId, item.id);
            const r = describeOutcomes([outcome]);
            toast(r.message, r.tone);
            setSigning(null);
          });
        }}
      />
    </>
  );
}

function BackLink() {
  return (
    <a className="back" href="#/">
      <ChevronLeftIcon size={18} /> All events
    </a>
  );
}

function ItemRow(props: {
  item: PlanItem;
  tripId: string;
  awaiting: boolean;
  busy: boolean;
  anyBusy: boolean;
  showTools: boolean;
  onApprove: () => void;
  onSign: () => void;
  onCancel: () => void;
  onSimulate: (kind: "price_spike" | "sold_out" | "flaky") => void;
}) {
  const { item, awaiting, busy, anyBusy, showTools } = props;
  const bookable = item.kind === "booking";
  const canApprove = bookable && !awaiting && (item.status === "proposed" || item.status === "approved");
  const canCancel = bookable && (item.status === "booked" || item.status === "proposed" || item.status === "approved");

  return (
    <li className="item">
      <div className="item-main">
        <p className="item-title">
          {item.title}
          {bookable && <ItemStatus status={item.status} awaiting={awaiting} />}
          {!bookable && <span className="pill pill-neutral">Estimate</span>}
        </p>
        {item.date && <p className="item-date">{formatTripDay(item.date)}</p>}
        <p className="item-why">{item.rationale}</p>
        {item.booking && (
          <p className="item-conf">
            Confirmation <strong>{item.booking.confirmationCode}</strong>. Paid {formatUsd(item.booking.pricePaidCents)}.
          </p>
        )}
        {showTools && bookable && item.offer && (
          <div className="tools">
            <button type="button" className="btn btn-small btn-light" disabled={anyBusy} onClick={() => props.onSimulate("price_spike")}>
              Price jump
            </button>
            <button type="button" className="btn btn-small btn-light" disabled={anyBusy} onClick={() => props.onSimulate("sold_out")}>
              Sold out
            </button>
            <button type="button" className="btn btn-small btn-light" disabled={anyBusy} onClick={() => props.onSimulate("flaky")}>
              Flaky supplier
            </button>
          </div>
        )}
      </div>
      <div className="item-side">
        <p className="item-price">{formatUsd(item.priceCents)}</p>
        <div className="item-actions">
          {awaiting && (
            <button type="button" className="btn btn-small btn-ink" disabled={anyBusy} onClick={props.onSign}>
              <PenIcon size={14} /> Sign
            </button>
          )}
          {canApprove && (
            <button type="button" className="btn btn-small btn-ink" disabled={anyBusy} onClick={props.onApprove}>
              {busy ? "Working…" : "Approve"}
            </button>
          )}
          {canCancel && (
            <button type="button" className="btn btn-small btn-danger" disabled={anyBusy} onClick={props.onCancel}>
              Cancel
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

function ItemStatus({ status, awaiting }: { status: PlanItem["status"]; awaiting: boolean }) {
  if (awaiting) return <StatusPill tone="yellow">Needs signature</StatusPill>;
  switch (status) {
    case "proposed":
      return <StatusPill tone="neutral">Ready to approve</StatusPill>;
    case "approved":
      return <StatusPill tone="teal">Approved</StatusPill>;
    case "booking":
      return <StatusPill tone="teal">Booking now</StatusPill>;
    case "booked":
      return <StatusPill tone="green">Booked</StatusPill>;
    case "failed":
      return <StatusPill tone="red">Failed</StatusPill>;
    case "cancelled":
      return <StatusPill tone="neutral">Cancelled</StatusPill>;
  }
}

function SignModal({
  item,
  trip,
  busy,
  onClose,
  onConfirm,
}: {
  item: PlanItem | null;
  trip: Trip;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal open={item !== null} title="Sign this payment" onClose={onClose}>
      {item && (
        <>
          <p>
            Your spending rules need your signature before the agent can pay for this booking.
          </p>
          <dl className="facts">
            <div>
              <dt>Booking</dt>
              <dd>{item.title}</dd>
            </div>
            <div>
              <dt>Amount</dt>
              <dd>{formatUsd(item.priceCents)}</dd>
            </div>
            <div>
              <dt>Trip cap</dt>
              <dd>{formatUsd(trip.plan.request.budgetCents)}</dd>
            </div>
          </dl>
          <p className="fine">This is the sandbox: signing approves the payment, but no real money moves.</p>
          <div className="modal-actions">
            <button type="button" className="btn btn-light" onClick={onClose} disabled={busy}>
              Not now
            </button>
            <button type="button" className="btn btn-ink" onClick={onConfirm} disabled={busy}>
              {busy ? "Signing…" : `Sign and pay ${formatUsd(item.priceCents)}`}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
