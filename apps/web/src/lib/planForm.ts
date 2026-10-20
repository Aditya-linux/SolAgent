import type { EventType, LodgingStyle, Pace } from "@solagent/shared";
import { nightsBetween } from "./format.ts";

export interface PlanFormState {
  eventType: EventType;
  origin: string;
  destination: string;
  startDate: string;
  endDate: string;
  travelers: number;
  /** Kept as text while typing; parsed on submit. */
  budget: string;
  lodgingStyle: LodgingStyle;
  pace: Pace;
  interests: string[];
  avoid: string;
  notes: string;
  mode: "optimizer" | "agent";
}

export type PlanFormErrors = Partial<Record<"origin" | "destination" | "startDate" | "endDate" | "travelers" | "budget", string>>;

const IATA = /^[A-Za-z]{3}$/;

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function defaultPlanForm(now: Date = new Date()): PlanFormState {
  const start = new Date(now.getTime() + 30 * 86_400_000);
  const end = new Date(now.getTime() + 35 * 86_400_000);
  return {
    eventType: "vacation",
    origin: "JFK",
    destination: "LIS",
    startDate: isoDay(start),
    endDate: isoDay(end),
    travelers: 2,
    budget: "3500",
    lodgingStyle: "standard",
    pace: "balanced",
    interests: ["food", "history"],
    avoid: "",
    notes: "",
    mode: "optimizer",
  };
}

export function validatePlanForm(form: PlanFormState, now: Date = new Date()): PlanFormErrors {
  const errors: PlanFormErrors = {};
  if (!IATA.test(form.destination.trim())) errors.destination = "Use the 3-letter airport code, like LIS.";
  if (form.origin.trim() !== "" && !IATA.test(form.origin.trim())) {
    errors.origin = "Use a 3-letter airport code, like JFK, or leave this empty if you don't need a flight.";
  }
  if (!form.startDate) errors.startDate = "Pick a start date.";
  else if (form.startDate < isoDay(now)) errors.startDate = "Pick a start date from today onward.";
  if (!form.endDate) errors.endDate = "Pick an end date.";
  else if (form.startDate && form.endDate <= form.startDate) errors.endDate = "The end date must be after the start date.";
  if (!Number.isInteger(form.travelers) || form.travelers < 1 || form.travelers > 9) errors.travelers = "Choose 1 to 9 travelers.";
  const budget = Number(form.budget);
  if (!form.budget.trim() || !Number.isFinite(budget) || budget <= 0) errors.budget = "Enter a budget above $0.";
  return errors;
}

/** Whole dollars per traveler per day, for the live summary under the form. */
export function perPersonPerDay(form: PlanFormState): number | undefined {
  const budget = Number(form.budget);
  if (!Number.isFinite(budget) || budget <= 0 || !form.startDate || !form.endDate) return undefined;
  const days = nightsBetween(form.startDate, form.endDate) + 1;
  if (days < 1 || form.travelers < 1) return undefined;
  return Math.round(budget / form.travelers / days);
}
