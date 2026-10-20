import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { DuffelClient, EVENT_TYPES, type ReplanTrigger } from "@solagent/shared";
import { createPlannerFromEnv, type TripPlanner } from "@solagent/planner";
import {
  BookingExecutor,
  DuffelFlightSupplier,
  SandboxPaymentGateway,
  SandboxSupplier,
  SupplierRegistry,
} from "@solagent/booking";
import { BadRequestError, NotFoundError, summarizeTrip, TripService, type TripEvent } from "./trips.ts";
import { SqliteTripStore } from "./store.ts";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

const preferencesSchema = z.object({
  lodgingStyle: z.enum(["budget", "standard", "luxury"]),
  pace: z.enum(["relaxed", "balanced", "packed"]),
  interests: z.array(z.string()).default([]),
  avoid: z.array(z.string()).optional(),
  notes: z.string().optional(),
  maxStops: z.number().int().min(0).optional(),
});

const tripRequestSchema = z
  .object({
    origin: z.string().length(3).toUpperCase().optional(),
    destination: z.string().length(3).toUpperCase(),
    destinationName: z.string().optional(),
    startDate: date,
    endDate: date,
    travelers: z.number().int().min(1).max(9),
    budgetUsd: z.number().positive(),
    preferences: preferencesSchema,
    travelerProfiles: z
      .array(
        z.object({
          givenName: z.string(),
          familyName: z.string(),
          bornOn: date,
          email: z.string().email(),
          phone: z.string(),
          gender: z.enum(["m", "f"]).optional(),
          title: z.enum(["mr", "ms", "mrs", "miss", "dr"]).optional(),
        }),
      )
      .optional(),
    mode: z.enum(["optimizer", "agent"]).optional(),
    eventType: z.enum(EVENT_TYPES).optional(),
  })
  .refine((r) => r.endDate > r.startDate, { message: "endDate must be after startDate" });

const triggerSchema: z.ZodType<ReplanTrigger> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("price_change"), itemId: z.string(), newPriceCents: z.number().int().positive() }),
  z.object({ type: z.literal("booking_failed"), itemId: z.string(), reason: z.string() }),
  z.object({ type: z.literal("offer_unavailable"), offerId: z.string() }),
  z.object({ type: z.literal("budget_change"), newBudgetCents: z.number().int().positive() }),
  z.object({ type: z.literal("remove_item"), itemId: z.string() }),
  z.object({ type: z.literal("pin_item"), itemId: z.string() }),
  z.object({ type: z.literal("preferences_change"), preferences: preferencesSchema.partial() }),
]);

const simulateSchema = z.object({
  itemId: z.string(),
  kind: z.enum(["price_spike", "sold_out", "flaky"]),
  /** For price_spike: multiplier on the current price (default 1.3). */
  factor: z.number().positive().optional(),
});

export interface AppDeps {
  planner: TripPlanner;
  service: TripService;
  sandbox: SandboxSupplier;
}

export function createDeps(): AppDeps {
  const planner = createPlannerFromEnv();
  const sandbox = new SandboxSupplier();
  const suppliers = new SupplierRegistry([sandbox]);
  const duffel = DuffelClient.fromEnv();
  if (duffel) suppliers.register(new DuffelFlightSupplier(duffel));
  const payments = new SandboxPaymentGateway();
  const executor = new BookingExecutor(suppliers, payments);
  // DATABASE_PATH=":memory:" runs SQLite in memory (handy for a throwaway
  // demo); unset it or point it at a file path to persist across restarts.
  const store = new SqliteTripStore(process.env.DATABASE_PATH ?? "data/trips.db");
  const service = new TripService(
    planner,
    executor,
    payments,
    { autoApproveUpToCents: Number(process.env.AUTO_APPROVE_UP_TO_CENTS ?? 50_000) },
    store,
  );
  return { planner, service, sandbox };
}

export function createApp(deps: AppDeps = createDeps()) {
  const { service, sandbox, planner } = deps;
  const app = new Hono();
  app.use("*", cors());

  app.onError((err, c) => {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof BadRequestError) return c.json({ error: err.message }, 400);
    if (err instanceof z.ZodError) return c.json({ error: "Invalid request", issues: err.issues }, 400);
    console.error(err);
    return c.json({ error: "Internal error" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true, agent: planner.agentAvailable }));

  app.post("/trips", async (c) => {
    const { budgetUsd, mode, ...rest } = tripRequestSchema.parse(await c.req.json());
    const trip = await service.createTrip({ ...rest, budgetCents: Math.round(budgetUsd * 100) }, mode);
    return c.json(trip, 201);
  });

  /** One row per trip with everything a list screen needs (id, summary and version are unchanged). */
  app.get("/trips", (c) => c.json(service.list().map(summarizeTrip)));
  app.get("/trips/:id", (c) => c.json(service.get(c.req.param("id"))));
  app.get("/trips/:id/plan", (c) => c.json(service.get(c.req.param("id")).plan));

  app.post("/trips/:id/items/:itemId/approve", async (c) =>
    c.json({ outcome: await service.approveItem(c.req.param("id"), c.req.param("itemId")) }),
  );
  app.post("/trips/:id/approve-all", async (c) => c.json({ outcomes: await service.approveAll(c.req.param("id")) }));
  app.post("/trips/:id/items/:itemId/sign", async (c) =>
    c.json({ outcome: await service.signPayment(c.req.param("id"), c.req.param("itemId")) }),
  );
  app.post("/trips/:id/items/:itemId/cancel", async (c) =>
    c.json(await service.cancelItem(c.req.param("id"), c.req.param("itemId"))),
  );

  app.post("/trips/:id/replan", async (c) =>
    c.json(await service.replan(c.req.param("id"), triggerSchema.parse(await c.req.json()))),
  );
  app.post("/trips/:id/refresh-prices", async (c) =>
    c.json({ changes: await service.refreshPrices(c.req.param("id")) }),
  );

  /** Demo helper: make the sandbox supplier misbehave for one item. */
  app.post("/trips/:id/simulate", async (c) => {
    const trip = service.get(c.req.param("id"));
    const body = simulateSchema.parse(await c.req.json());
    const item = trip.plan.items.find((i) => i.id === body.itemId);
    if (!item?.offer) throw new NotFoundError(`Bookable item ${body.itemId} not found`);
    if (body.kind === "price_spike") sandbox.setPrice(item.offer.id, Math.round(item.priceCents * (body.factor ?? 1.3)));
    if (body.kind === "sold_out") sandbox.markSoldOut(item.offer.id);
    if (body.kind === "flaky") sandbox.failNext(item.offer.id, 2, "transient");
    return c.json({ ok: true });
  });

  /** Live trip feed for the product surface (Server-Sent Events). */
  app.get("/trips/:id/events", (c) => {
    const trip = service.get(c.req.param("id"));
    return streamSSE(c, async (stream) => {
      for (const e of trip.events) await stream.writeSSE({ event: e.type, data: JSON.stringify(e), id: e.id });
      const onEvent = (e: TripEvent) => {
        if (e.tripId === trip.id) void stream.writeSSE({ event: e.type, data: JSON.stringify(e), id: e.id });
      };
      service.events.on("event", onEvent);
      stream.onAbort(() => {
        service.events.off("event", onEvent);
      });
      while (!stream.aborted) await stream.sleep(15_000);
    });
  });

  return app;
}
