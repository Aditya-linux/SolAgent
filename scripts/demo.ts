/**
 * End-to-end walkthrough of the core loop with sandbox suppliers and payments:
 *   plan -> approve -> real-world failures -> replan -> book
 *
 *   npm run demo              # deterministic optimizer
 *   npm run demo -- --agent   # Claude planning agent (needs ANTHROPIC_API_KEY)
 */
import { formatUsd, type TravelPlan } from "@solagent/shared";
import { createDeps } from "@solagent/api";

const useAgent = process.argv.includes("--agent");
const { service, sandbox } = createDeps();

function printPlan(plan: TravelPlan) {
  console.log(`\n── Plan v${plan.version} (${plan.source}) ─────────────────────────────`);
  console.log(plan.summary);
  for (const i of plan.items) {
    const status = i.kind === "estimate" ? "estimate" : i.status;
    console.log(
      `  ${status.padEnd(9)} ${i.category.padEnd(15)} ${formatUsd(i.priceCents).padStart(10)}  ${i.date ?? "          "}  ${i.title}`,
    );
  }
  console.log("  Envelopes:");
  for (const e of plan.envelopes) {
    console.log(
      `    ${e.category.padEnd(15)} cap ${formatUsd(e.allocatedCents).padStart(10)}  planned ${formatUsd(e.plannedCents).padStart(10)}  paid ${formatUsd(e.committedCents).padStart(10)}`,
    );
  }
  console.log(`    buffer          ${formatUsd(plan.bufferCents).padStart(14)}`);
  if (plan.warnings.length) console.log("  Warnings:", plan.warnings);
}

service.events.on("event", (e) => console.log(`  [${e.type}] ${e.message}`));

console.log("Planning a 5-night Lisbon trip for 2, $3,500 budget…");
const trip = await service.createTrip(
  {
    origin: "JFK",
    destination: "LIS",
    startDate: "2026-11-10",
    endDate: "2026-11-15",
    travelers: 2,
    budgetCents: 350_000,
    preferences: {
      lodgingStyle: "standard",
      pace: "balanced",
      interests: ["food", "history", "music"],
      avoid: ["red-eye"],
      notes: "First time in Portugal. We'd rather walk everywhere than take taxis.",
    },
  },
  useAgent ? "agent" : "optimizer",
);
printPlan(trip.plan);
if (trip.agentLog) console.log(`  (agent made ${trip.agentLog.length} tool calls)`);

const byCategory = (c: string) => service.get(trip.id).plan.items.find((i) => i.category === c)!;

console.log("\n▶ The hotel sells out before we book, the flight API is flaky, and the first activity's price jumps 40%.");
sandbox.markSoldOut(byCategory("lodging").offer!.id);
sandbox.failNext(byCategory("flights").offer!.id, 2, "transient");
const firstActivity = byCategory("activities");
sandbox.setPrice(firstActivity.offer!.id, Math.round(firstActivity.priceCents * 1.4));

console.log("\n▶ User taps “Approve all”.");
await service.approveAll(trip.id);

const pending = Object.keys(service.get(trip.id).pendingSignatures);
if (pending.length) {
  console.log(`\n▶ ${pending.length} payment(s) above the auto-approve limit; user signs in the wallet.`);
  for (const itemId of pending) await service.signPayment(trip.id, itemId);
}

console.log("\n▶ Approving whatever the replanner proposed as replacements.");
await service.approveAll(trip.id);
for (const itemId of Object.keys(service.get(trip.id).pendingSignatures)) await service.signPayment(trip.id, itemId);

printPlan(service.get(trip.id).plan);
console.log(`\nPlan history: ${service.get(trip.id).history.map((h) => `v${h.version} ${formatUsd(h.totalCents)}`).join(" → ")}`);
