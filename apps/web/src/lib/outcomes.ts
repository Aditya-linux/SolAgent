import type { BookingOutcome } from "@solagent/shared";
import { plural } from "./format.ts";

export interface OutcomeMessage {
  message: string;
  tone: "success" | "info" | "warning";
}

/** One plain-language sentence for what happened after "Approve". */
export function describeOutcomes(outcomes: BookingOutcome[]): OutcomeMessage {
  if (outcomes.length === 0) return { message: "Nothing left to approve.", tone: "info" };

  let booked = 0;
  let waiting = 0;
  let blocked = 0;
  let changed = 0;
  for (const o of outcomes) {
    switch (o.status) {
      case "booked":
        booked += 1;
        break;
      case "awaiting_user":
        waiting += 1;
        break;
      case "payment_rejected":
        blocked += 1;
        break;
      case "price_changed":
      case "unavailable":
      case "failed":
        changed += 1;
        break;
    }
  }

  const parts: string[] = [];
  if (booked > 0) parts.push(`Booked ${plural(booked, "item")}.`);
  if (waiting > 0) parts.push(`${plural(waiting, "payment")} ${waiting === 1 ? "needs" : "need"} your signature.`);
  if (blocked > 0) parts.push(`${plural(blocked, "payment")} blocked by your spending rules.`);
  if (changed > 0) {
    parts.push(`${plural(changed, "item")} changed price or sold out, so the agent made a new plan.`);
  }
  const tone = blocked > 0 || changed > 0 ? "warning" : booked > 0 ? "success" : "info";
  return { message: parts.join(" "), tone };
}
