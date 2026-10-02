import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { formatUsd, nightsBetween, type TravelPlan } from "@solagent/shared";
import {
  buildPlan,
  daySlots,
  evaluateSelection,
  optimize,
  type PlanningContext,
  type Selection,
} from "./optimizer.ts";
import { activityScore, hotelScore, isAvoided } from "./scoring.ts";

/**
 * LLM planning agent. The deterministic optimizer produces a baseline; Claude
 * then searches the same candidate set with tools, reasons about soft
 * preferences the scorer can't capture (notes like "first time in Europe",
 * "traveling with a toddler"), and submits a selection. Every selection is
 * validated by the same evaluator, so the agent can't produce an over-budget or
 * impossible plan — an invalid submission is bounced back with the errors.
 */

export interface PlanningAgentOptions {
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxIterations?: number;
  client?: Anthropic;
}

export interface AgentRun {
  plan: TravelPlan;
  /** Tool calls the agent made, for debugging and the "agent is thinking" UI. */
  log: { tool: string; input: unknown }[];
  usedFallback: boolean;
}

const SYSTEM_PROMPT = `You are the planning engine of an autonomous travel agent that books real trips and pays from the traveler's wallet.

Your job: choose the flight, lodging and activities for one trip so the traveler gets the best trip their budget allows.

How to work:
- You receive a trip brief with the budget split into category envelopes, fixed food/transport estimates, and a baseline selection from a deterministic optimizer. The baseline is valid and within budget; treat it as a starting point to improve on, not as the answer.
- Use the search tools to look at alternatives. Weigh real tradeoffs explicitly: e.g. a cheaper hotel 6 km out vs. a pricier one in the center, a nonstop flight vs. saving money for an extra activity.
- Honor the traveler's notes and avoid list; they describe things the scoring model cannot see.
- Use evaluate_plan to check totals before submitting. Stay within the total budget; it is fine to leave money unspent when upgrades are not worth it. Keep the contingency buffer intact when you can.
- Activities must be scheduled on dates they are available, within the per-day slot limits.
- Finish by calling submit_plan exactly once with a short, concrete reason for each chosen offer (what it gives the traveler and what it was traded against). If it is rejected, fix the listed errors and submit again.`;

const selectionShape = {
  flight_id: z.string().optional().describe("Offer id of the chosen round-trip flight"),
  hotel_id: z.string().optional().describe("Offer id of the chosen lodging"),
  activities: z
    .array(z.object({ offer_id: z.string(), date: z.string().describe("YYYY-MM-DD") }))
    .describe("Chosen activities with the date each one happens"),
};

function toSelection(input: {
  flight_id?: string;
  hotel_id?: string;
  activities: { offer_id: string; date: string }[];
}): Selection {
  return {
    flightId: input.flight_id,
    hotelId: input.hotel_id,
    activities: input.activities.map((a) => ({ offerId: a.offer_id, date: a.date })),
  };
}

const usd = (cents: number) => Math.round(cents) / 100;

function tripBrief(ctx: PlanningContext, baseline: Selection): string {
  const req = ctx.request;
  const evaluation = evaluateSelection(ctx, baseline);
  return JSON.stringify(
    {
      trip: {
        origin: req.origin ?? null,
        destination: req.destinationName ?? req.destination,
        dates: `${req.startDate} to ${req.endDate} (${nightsBetween(req.startDate, req.endDate)} nights)`,
        travelers: req.travelers,
        preferences: req.preferences,
      },
      budget_usd: usd(req.budgetCents),
      envelopes_usd: Object.fromEntries(ctx.allocation.envelopes.map((e) => [e.category, usd(e.allocatedCents)])),
      contingency_buffer_usd: usd(ctx.allocation.bufferCents),
      fixed_estimates_usd: {
        food: usd(ctx.allocation.estimates.foodCents),
        local_transport: usd(ctx.allocation.estimates.localTransportCents),
      },
      activity_slots_per_day: Object.fromEntries(daySlots(req)),
      baseline_selection: {
        flight_id: baseline.flightId,
        hotel_id: baseline.hotelId,
        activities: baseline.activities.map((a) => ({ offer_id: a.offerId, date: a.date })),
        total_usd: usd(evaluation.totalCents),
        remaining_usd: usd(evaluation.remainingCents),
      },
    },
    null,
    2,
  );
}

export class PlanningAgent {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly effort: NonNullable<PlanningAgentOptions["effort"]>;
  private readonly maxIterations: number;

  constructor(opts: PlanningAgentOptions = {}) {
    this.client = opts.client ?? new Anthropic();
    this.model = opts.model ?? process.env.PLANNER_MODEL ?? "claude-opus-5-5";
    this.effort = opts.effort ?? (process.env.PLANNER_EFFORT as PlanningAgentOptions["effort"]) ?? "high";
    this.maxIterations = opts.maxIterations ?? 16;
  }

  async plan(ctx: PlanningContext, meta: { tripId: string }): Promise<AgentRun> {
    const baseline = optimize(ctx);
    const log: AgentRun["log"] = [];
    let submitted: { selection: Selection; rationales: Record<string, string>; summary: string } | undefined;
    const prefs = ctx.request.preferences;
    const usable = <T extends { id: string }>(xs: T[]) =>
      xs.filter((o) => !ctx.excludedOfferIds.has(o.id) && !isAvoided(o as never, prefs));

    const tools = [
      betaZodTool({
        name: "search_flights",
        description:
          "List round-trip flight offers for this trip. Prices are totals for all travelers in USD. Returns up to 12 offers.",
        inputSchema: z.object({
          max_stops: z.number().int().min(0).optional(),
          max_price_usd: z.number().optional(),
          sort_by: z.enum(["price", "duration"]).optional(),
        }),
        run: async (input) => {
          log.push({ tool: "search_flights", input });
          const offers = usable(ctx.candidates.flights)
            .filter((f) => input.max_stops === undefined || f.stops <= input.max_stops)
            .filter((f) => input.max_price_usd === undefined || f.priceCents <= input.max_price_usd * 100)
            .sort((a, b) =>
              input.sort_by === "duration" ? a.durationMinutes - b.durationMinutes : a.priceCents - b.priceCents,
            )
            .slice(0, 12);
          return JSON.stringify(
            offers.map((f) => ({
              id: f.id,
              title: f.title,
              price_usd: usd(f.priceCents),
              stops: f.stops,
              duration_hours: Math.round(f.durationMinutes / 6) / 10,
              outbound_departs: f.outboundDepartAt,
              return_departs: f.returnDepartAt,
              red_eye: f.redEye,
              refundable: f.refundable,
            })),
          );
        },
      }),
      betaZodTool({
        name: "search_hotels",
        description:
          "List lodging offers. Prices are totals for the whole stay (all rooms, all nights) in USD. fit_score (0-1) is the scoring model's rating of rating+location+style fit.",
        inputSchema: z.object({
          style: z.enum(["budget", "standard", "luxury"]).optional(),
          max_distance_km: z.number().optional(),
          max_price_usd: z.number().optional(),
          sort_by: z.enum(["price", "rating", "distance"]).optional(),
        }),
        run: async (input) => {
          log.push({ tool: "search_hotels", input });
          const offers = usable(ctx.candidates.hotels)
            .filter((h) => !input.style || h.style === input.style)
            .filter((h) => input.max_distance_km === undefined || h.distanceKm <= input.max_distance_km)
            .filter((h) => input.max_price_usd === undefined || h.priceCents <= input.max_price_usd * 100)
            .sort((a, b) =>
              input.sort_by === "rating"
                ? b.rating - a.rating
                : input.sort_by === "distance"
                  ? a.distanceKm - b.distanceKm
                  : a.priceCents - b.priceCents,
            )
            .slice(0, 12);
          return JSON.stringify(
            offers.map((h) => ({
              id: h.id,
              title: h.title,
              price_usd: usd(h.priceCents),
              style: h.style,
              rating: h.rating,
              distance_km_from_center: h.distanceKm,
              free_cancellation: h.freeCancellation,
              amenities: h.amenities,
              fit_score: Math.round(hotelScore(h, prefs) * 100) / 100,
            })),
          );
        },
      }),
      betaZodTool({
        name: "search_activities",
        description:
          "List bookable activities. Prices are totals for all travelers in USD. available_dates empty means any day of the trip.",
        inputSchema: z.object({
          interest: z.string().optional().describe("Filter by tag, e.g. 'food' or 'museums'"),
          date: z.string().optional().describe("Only activities available on this date (YYYY-MM-DD)"),
          max_price_usd: z.number().optional(),
        }),
        run: async (input) => {
          log.push({ tool: "search_activities", input });
          const offers = usable(ctx.candidates.activities)
            .filter((a) => !input.interest || a.tags.some((t) => t.includes(input.interest!.toLowerCase())))
            .filter((a) => !input.date || a.availableDates.length === 0 || a.availableDates.includes(input.date))
            .filter((a) => input.max_price_usd === undefined || a.priceCents <= input.max_price_usd * 100)
            .sort((a, b) => activityScore(b, prefs) - activityScore(a, prefs));
          return JSON.stringify(
            offers.map((a) => ({
              id: a.id,
              title: a.title,
              price_usd: usd(a.priceCents),
              tags: a.tags,
              rating: a.rating,
              duration_hours: a.durationHours,
              available_dates: a.availableDates,
            })),
          );
        },
      }),
      betaZodTool({
        name: "evaluate_plan",
        description:
          "Check a candidate selection: returns per-category totals, remaining budget, a value score (higher is better, comparable across selections for this trip) and any errors. Does not submit.",
        inputSchema: z.object(selectionShape),
        run: async (input) => {
          log.push({ tool: "evaluate_plan", input });
          const e = evaluateSelection(ctx, toSelection(input));
          return JSON.stringify({
            ok: e.ok,
            errors: e.errors,
            warnings: e.warnings,
            total_usd: usd(e.totalCents),
            remaining_usd: usd(e.remainingCents),
            by_category_usd: Object.fromEntries(Object.entries(e.byCategory).map(([k, v]) => [k, usd(v)])),
            value_score: Math.round(e.valueUsd),
          });
        },
      }),
      betaZodTool({
        name: "submit_plan",
        description:
          "Submit the final selection. It is validated; if rejected, the errors are returned and you should fix them and submit again.",
        inputSchema: z.object({
          ...selectionShape,
          reasons: z
            .array(z.object({ offer_id: z.string(), reason: z.string() }))
            .describe("One short reason per chosen offer: what it gives the traveler and what it was traded against"),
          summary: z.string().describe("Two or three sentences summarizing the plan and the main tradeoffs"),
        }),
        run: async (input) => {
          log.push({ tool: "submit_plan", input });
          const selection = toSelection(input);
          const e = evaluateSelection(ctx, selection);
          if (!e.ok) return `REJECTED. Fix these errors and submit again:\n- ${e.errors.join("\n- ")}`;
          submitted = {
            selection,
            rationales: Object.fromEntries(input.reasons.map((r) => [r.offer_id, r.reason])),
            summary: input.summary,
          };
          return `Accepted. Total ${formatUsd(e.totalCents)}, ${formatUsd(e.remainingCents)} left. You are done.`;
        },
      }),
    ];

    let usedFallback = false;
    try {
      const final = await this.client.beta.messages.toolRunner({
        model: this.model,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        output_config: { effort: this.effort },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        max_iterations: this.maxIterations,
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools,
        messages: [
          {
            role: "user",
            content: `Plan this trip. Trip brief:\n\n${tripBrief(ctx, baseline)}`,
          },
        ],
      });
      if (final.stop_reason === "refusal") usedFallback = true;
    } catch (err) {
      if (!(err instanceof Anthropic.APIError)) throw err;
      log.push({ tool: "error", input: { status: err.status, message: err.message } });
      usedFallback = true;
    }

    if (!submitted) {
      usedFallback = true;
      return {
        plan: buildPlan(ctx, baseline, {
          source: "optimizer",
          tripId: meta.tripId,
          warnings: [...baseline.notes, "Planning agent did not finish; using the optimizer's plan."],
        }),
        log,
        usedFallback,
      };
    }
    return {
      plan: buildPlan(ctx, submitted.selection, {
        source: "agent",
        tripId: meta.tripId,
        rationales: submitted.rationales,
        summary: submitted.summary,
      }),
      log,
      usedFallback,
    };
  }
}
