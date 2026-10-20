# SolAgent

An autonomous travel agent: give it a destination, dates, preferences and a budget. It plans the trip, splits the budget into spending envelopes, books flights, lodging and activities, and pays from a Solana wallet under programmable spending rules. When prices move or a booking fails, it replans.

## Layout

```
packages/
  shared/    Domain types + the contracts between layers (TravelPlan, PaymentGateway, BookingOutcome), Duffel client
  planner/   Planning & optimization engine: budget allocator, optimizer, Claude planning agent, replanner, search providers
  booking/   Booking execution: supplier adapters (sandbox, Duffel), executor (re-quote → authorize → book → capture), sandbox payments
  api/       Trip orchestration service + HTTP API (Hono), SQLite-backed persistence (store.ts), live event stream for the app
apps/
  web/       React + Vite product surface: create a trip, see the live itinerary, approve/sign/cancel, SSE updates
scripts/
  demo.ts    End-to-end walkthrough: plan → approve → failures → replan → book
```

## Quick start

```bash
npm install
npm test            # 43 tests: allocator, optimizer, replanner, agent tools, executor, API
npm run demo        # full loop in the terminal with sandbox suppliers and payments
npm run dev         # API on http://localhost:8787 (trips persist to data/trips.db)
npm run dev:web     # web app on http://localhost:5173
```

Optional, in `.env` (see `.env.example`):

| Variable | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | Turns on the Claude planning agent (`claude-opus-5-5`). Without it the deterministic optimizer plans on its own. |
| `PLANNER_EFFORT` | `low` … `max`, default `high`. |
| `DUFFEL_ACCESS_TOKEN` + `FLIGHT_PROVIDER=duffel` | Live flight search and real (test-mode) flight bookings through Duffel. Use a `duffel_test_…` token. |
| `AUTO_APPROVE_UP_TO_CENTS` | Spends above this need the traveler's signature. Default 50000 ($500). |
| `DATABASE_PATH` | Where trips are persisted (SQLite). Default `data/trips.db`; use `:memory:` for a throwaway run. |

`npm run demo -- --agent` runs the demo with the Claude agent.

In `apps/web/.env` (see `apps/web/.env.example`): `VITE_API_URL` if the API isn't on the default `http://localhost:8787`.

## The web app (apps/web)

Three columns, as in the Figma: event-type filters and page tools on the left, the working area in the middle, main actions on the right (folded into a top bar and bottom bar on phones).

| Screen | Route | Data |
| --- | --- | --- |
| Events | `#/` and `#/?type=flight` | `GET /trips` (polled every 8 s) |
| Event | `#/event/<id>` | `GET /trips/:id` plus the live SSE stream |
| Plan New Event | `#/new` | `POST /trips` |
| Fund Wallet | `#/wallet` | **Demo only**: a pretend balance in localStorage. Paid and waiting figures are real. |
| History, Notifications | `#/history`, `#/notifications` | Built from each trip's event log and pending signatures |
| Support | `#/support` | `GET /health` and a copy-diagnostics button |

`eventType` (flight, vacation, shopping, international, local) is a label for filtering. The planner treats all types the same.

## How the planning engine works

1. **Search.** `SearchProvider` gathers flights, hotels, activities and a daily cost index. `MockSearchProvider` gives deterministic sandbox data for any IATA code. `DuffelFlightSearch` gives live fares. `CompositeSearchProvider` mixes the two.
2. **Allocate** (`allocator.ts`). The allocator holds back a 5% contingency buffer. Food and local transport are estimated from the cost index. What's left is split across flights, lodging and activities by preference-weighted shares, raised where needed so every category gets at least its market floor (the cheapest real offer). The envelopes become the payments layer's per-category caps.
3. **Optimize** (`optimizer.ts`). The optimizer starts from the cheapest valid plan. It then greedily applies whichever change gives the most quality per dollar: swap the flight, swap the hotel, or add an activity. Quality scores (`scoring.ts`) cover rating, distance to center, style fit, stops, duration, red-eyes and interest match. The value weights are calibrated against market prices, so "cheaper hotel 6 km out vs. pricier central one" is an explicit dollar comparison. Envelopes are soft caps: going over one is allowed only when the upgrade is clearly worth it. Every plan item has a written rationale and up to three alternatives.
4. **Agent** (`agent.ts`, optional). Claude gets the trip brief and the optimizer's baseline. Its tools are `search_flights`, `search_hotels`, `search_activities`, `evaluate_plan` and `submit_plan`. It handles soft preferences that the scorer can't see, such as free-text notes. Each submission is checked by the same evaluator the optimizer uses. An over-budget or impossible plan is sent back with the errors. If the agent never finishes, the optimizer's plan is used.
5. **Replan** (`replanner.ts`):

| Trigger | Response |
|---|---|
| Small price increase | Absorbed by envelope headroom or the buffer. The item needs re-approval. |
| Big price increase, sold out, booking failed | Only the affected slot is repaired. If that doesn't fit the budget, all unlocked items are re-optimized. |
| Budget or preferences change | Fresh market search, then full re-optimization. |

    Booked, booking, approved and pinned items are never touched. Failed offers are never proposed again.

## How booking execution works

`BookingExecutor.execute(item)`:

1. **Re-quote** with the supplier. If the offer is unavailable it returns `unavailable`. If the price is more than max(2%, $5) above what was approved, it returns `price_changed` and nothing is charged.
2. **Authorize** the spend with the payments layer, which runs the spending rules. If the user has to sign, it returns `awaiting_user`. Calling `execute` again after signing resumes the same authorization.
3. **Book** using a deterministic idempotency key, retrying transient errors with backoff.
4. **Capture** the payment. If capture fails, the supplier booking is cancelled. Any failure after step 2 voids the hold, so a failed booking never moves money.

`TripService` (api) sends `price_changed`, `unavailable` and `failed` outcomes back into the replanner, and keeps the spending rules in sync with the current envelopes.

## Persistence

Trips are stored through the `TripStore` interface (`packages/api/src/store.ts`): `list`, `get`, `save`. `TripService` calls `save` once, inside its private `emit()` helper — every mutating method ends by emitting an event, so that's the single place a trip is written back, and adding a new mutation only needs to end in `emit()` to be durable.

Two implementations:
- `InMemoryTripStore` — the default when no store is passed to `TripService`, used by the existing tests. Same behavior as the old in-memory `Map`.
- `SqliteTripStore` — what `createDeps()` (api) actually uses. Built on Node's built-in `node:sqlite`, so there's no native dependency to install. A trip (plan, envelopes, items, offers, history, events) is stored as one JSON row per trip rather than normalized into columns — nothing needs to query *inside* a trip from SQL yet. If that changes, that's the point to add real columns or a child table for the data that needs it, not before.

## Interfaces for the other layers

**Payments & wallet (Solana):** implement `PaymentGateway` from `@solagent/shared`:

```ts
interface PaymentGateway {
  authorize(req: SpendRequest): Promise<SpendAuthorization>;   // "authorized" | "pending_user" | "rejected"
  capture(authorizationId, finalAmountCents): Promise<PaymentReceipt>;  // txRef = Solana tx signature
  void(authorizationId): Promise<void>;
  refund(receiptId, amountCents): Promise<PaymentReceipt>;
}
```

`authorize` and `capture` must be idempotent (see the comment on the type). Two optional hooks are also supported: `setRules(tripId, rules)`, which receives the per-category caps derived from the plan, and `approvePending(authId)`, for in-app signing. `SandboxPaymentGateway` is a working reference: category caps, a daily limit, a merchant allowlist and an auto-approve threshold. Amounts are integer USD cents, and USDC conversion happens inside the payments layer.

**Product surface:** HTTP API (all JSON):

| Method | Path | |
|---|---|---|
| `POST` | `/trips` | Create and plan a trip (`budgetUsd`, `preferences`, optional `mode: "agent" \| "optimizer"`) |
| `GET` | `/trips/:id` | Plan, history, events, pending signatures |
| `POST` | `/trips/:id/items/:itemId/approve` | Approve and book one item |
| `POST` | `/trips/:id/approve-all` | Approve and book everything proposed |
| `POST` | `/trips/:id/items/:itemId/sign` | User signed a payment above the auto-approve limit |
| `POST` | `/trips/:id/items/:itemId/cancel` | Cancel (refund if booked) and let the planner adjust |
| `POST` | `/trips/:id/replan` | Any `ReplanTrigger`, e.g. `{"type":"budget_change","newBudgetCents":300000}` |
| `POST` | `/trips/:id/refresh-prices` | Re-quote everything unbooked, replan on significant moves |
| `GET` | `/trips/:id/events` | Server-Sent Events feed for the live trip view |
| `POST` | `/trips/:id/simulate` | Demo helper: `price_spike` / `sold_out` / `flaky` for a sandbox item |

**Adding a supplier:** implement `SupplierAdapter` (`quote`, `book`, `cancel`) and register it in `SupplierRegistry`. The supplier name must match `offer.supplier` from the search provider.

## Roadmap status

- **Phase 0:** done. Planning and optimization, budget envelopes, mock bookings and payments, replanning, SQLite persistence, and a basic web UI (create a trip, see the live itinerary, approve/sign/cancel, live events).
- **Phase 1:** the payments interface is ready for the Solana layer — `SandboxPaymentGateway` is a reference implementation to build the real one against. Sandbox suppliers are in place.
- **Phase 2:** Duffel flight search and booking adapters are written but not yet run against a live token. Hotels and activities still need real suppliers. Candidates: Duffel Stays, Hotelbeds, Viator, GetYourGuide.
- **Phase 3:** add more suppliers per category behind the same `SearchProvider` and `SupplierAdapter` interfaces. The optimizer already compares across suppliers.

Not yet done: auth (any trip ID can be read/written by anyone who has it), and the web UI's manual `/replan` triggers (budget or preference changes) aren't wired up — only approve/sign/cancel/refresh-prices are.
