import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { evaluateSelection, optimize, PlanningAgent } from "../src/index.ts";
import { lisbonContext } from "./fixtures.ts";

type Tool = { name: string; run: (input: unknown) => Promise<string> };

/**
 * Stands in for Claude: drives the agent's tools the way the model would, so
 * the tool plumbing and validation are tested without network calls.
 */
function fakeClient(script: (tools: Record<string, Tool>) => Promise<void>, captured: { params?: unknown } = {}) {
  return {
    beta: {
      messages: {
        toolRunner: async (params: { tools: Tool[] }) => {
          captured.params = params;
          await script(Object.fromEntries(params.tools.map((t) => [t.name, t])));
          return { stop_reason: "end_turn", content: [] };
        },
      },
    },
  } as unknown as Anthropic;
}

describe("PlanningAgent", () => {
  it("bounces invalid submissions and builds the plan from the accepted one", async () => {
    const { ctx, candidates } = await lisbonContext();
    const baseline = optimize(ctx);
    const replies: string[] = [];
    const captured: { params?: any } = {};
    const agent = new PlanningAgent({
      client: fakeClient(async (tools) => {
        const flights = JSON.parse(await tools.search_flights!.run({ sort_by: "duration" }));
        expect(flights.every((f: { red_eye: boolean }) => !f.red_eye)).toBe(true);
        // Over budget: the priciest hotel plus every activity on day one.
        const priciest = [...candidates.hotels].sort((a, b) => b.priceCents - a.priceCents)[0]!;
        replies.push(
          await tools.submit_plan!.run({
            flight_id: flights[0].id,
            hotel_id: priciest.id,
            activities: candidates.activities.slice(0, 5).map((a) => ({ offer_id: a.id, date: "2026-11-10" })),
            reasons: [],
            summary: "too much",
          }),
        );
        replies.push(
          await tools.submit_plan!.run({
            flight_id: baseline.flightId,
            hotel_id: baseline.hotelId,
            activities: baseline.activities.map((a) => ({ offer_id: a.offerId, date: a.date })),
            reasons: [{ offer_id: baseline.hotelId!, reason: "Central and well rated" }],
            summary: "Agent plan",
          }),
        );
      }, captured),
    });

    const run = await agent.plan(ctx, { tripId: "t" });
    expect(replies[0]).toMatch(/^REJECTED/);
    expect(replies[1]).toMatch(/^Accepted/);
    expect(run.usedFallback).toBe(false);
    expect(run.plan.source).toBe("agent");
    expect(run.plan.summary).toBe("Agent plan");
    expect(run.plan.items.find((i) => i.offer?.id === baseline.hotelId)?.rationale).toBe("Central and well rated");
    expect(evaluateSelection(ctx, baseline).ok).toBe(true);
    expect(captured.params.model).toBe("claude-opus-5-5");
    expect(captured.params.thinking).toEqual({ type: "adaptive" });
  });

  it("falls back to the optimizer plan when the agent never submits", async () => {
    const { ctx } = await lisbonContext();
    const agent = new PlanningAgent({ client: fakeClient(async () => {}) });
    const run = await agent.plan(ctx, { tripId: "t" });
    expect(run.usedFallback).toBe(true);
    expect(run.plan.source).toBe("optimizer");
    expect(run.plan.warnings.join(" ")).toMatch(/did not finish/);
  });
});
