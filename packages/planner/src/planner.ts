import { DuffelClient, type ReplanResult, type ReplanTrigger, type TravelPlan, type TripRequest } from "@solagent/shared";
import { PlanningAgent, type AgentRun } from "./agent.ts";
import { buildPlan, createContext, optimize } from "./optimizer.ts";
import { DuffelFlightSearch } from "./providers/duffel.ts";
import { cityName, MockSearchProvider } from "./providers/mock.ts";
import {
  CompositeSearchProvider,
  gatherCandidates,
  type CandidateSet,
  type SearchProvider,
} from "./providers/types.ts";
import { Replanner, type ReplanOptions } from "./replanner.ts";

export type PlanMode = "optimizer" | "agent";

export interface PlanOutcome {
  plan: TravelPlan;
  /** Keep these with the trip: the replanner works from the same market snapshot. */
  candidates: CandidateSet;
  agentLog?: AgentRun["log"];
}

/** Facade the API/product layer talks to. */
export class TripPlanner {
  readonly replanner: Replanner;

  constructor(
    private readonly provider: SearchProvider,
    private readonly agent?: PlanningAgent,
    replanOptions?: ReplanOptions,
  ) {
    this.replanner = new Replanner(replanOptions);
  }

  get agentAvailable(): boolean {
    return this.agent !== undefined;
  }

  async searchCandidates(request: TripRequest): Promise<CandidateSet> {
    return gatherCandidates(this.provider, request);
  }

  async plan(request: TripRequest, opts: { tripId: string; mode?: PlanMode }): Promise<PlanOutcome> {
    const req = { ...request, destinationName: request.destinationName ?? cityName(request.destination) };
    const candidates = await this.searchCandidates(req);
    const ctx = createContext(req, candidates);
    const mode = opts.mode ?? (this.agent ? "agent" : "optimizer");
    if (mode === "agent" && this.agent) {
      const run = await this.agent.plan(ctx, { tripId: opts.tripId });
      return { plan: run.plan, candidates, agentLog: run.log };
    }
    const sel = optimize(ctx);
    const plan = buildPlan(ctx, sel, { source: "optimizer", tripId: opts.tripId, warnings: sel.notes });
    return { plan, candidates };
  }

  replan(plan: TravelPlan, trigger: ReplanTrigger, candidates: CandidateSet): ReplanResult {
    return this.replanner.replan(plan, trigger, candidates);
  }
}

/**
 * Wire providers from env:
 * - FLIGHT_PROVIDER=duffel + DUFFEL_ACCESS_TOKEN -> live Duffel flight search
 * - ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN / PLANNER_AGENT=on) -> LLM planning agent
 */
export function createPlannerFromEnv(): TripPlanner {
  const mock = new MockSearchProvider();
  const duffel = process.env.FLIGHT_PROVIDER === "duffel" ? DuffelClient.fromEnv() : undefined;
  const provider = duffel
    ? new CompositeSearchProvider({
        flights: new DuffelFlightSearch(duffel),
        hotels: mock,
        activities: mock,
        costs: mock,
      })
    : mock;
  const agentEnabled =
    process.env.PLANNER_AGENT !== "off" &&
    Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.PLANNER_AGENT === "on");
  return new TripPlanner(provider, agentEnabled ? new PlanningAgent() : undefined);
}
