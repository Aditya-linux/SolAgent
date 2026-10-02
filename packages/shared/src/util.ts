import { randomUUID } from "node:crypto";
import type { Cents } from "./types.ts";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

const DAY_MS = 86_400_000;

function parseDate(d: string): number {
  const t = Date.parse(`${d}T00:00:00Z`);
  if (Number.isNaN(t)) throw new Error(`Invalid date: ${d}`);
  return t;
}

/** Number of nights between check-in and check-out. */
export function nightsBetween(start: string, end: string): number {
  return Math.round((parseDate(end) - parseDate(start)) / DAY_MS);
}

/** Every calendar day of the trip, inclusive of start and end. */
export function tripDays(start: string, end: string): string[] {
  const days: string[] = [];
  for (let t = parseDate(start); t <= parseDate(end); t += DAY_MS) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

export function formatUsd(cents: Cents): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Parse a decimal amount string ("123.45") into integer cents. */
export function toCents(amount: string | number): Cents {
  return Math.round(Number(amount) * 100);
}

export function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

/** Deterministic PRNG (mulberry32) seeded from a string, for reproducible mock data. */
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
