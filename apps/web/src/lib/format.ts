import type { Cents } from "@solagent/shared";

const usdWhole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 });
const usdCents = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "$644" for whole dollars, "$644.50" otherwise. */
export function formatUsd(cents: Cents): string {
  const abs = Math.abs(cents);
  const text = (abs % 100 === 0 ? usdWhole : usdCents).format(abs / 100);
  return cents < 0 ? `-${text}` : text;
}

export function plural(count: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : pluralNoun}`;
}

const MS_DAY = 86_400_000;

/** Trip dates are plain YYYY-MM-DD strings; read them as UTC so they never shift a day. */
function parseDay(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

export function nightsBetween(start: string, end: string): number {
  return Math.max(0, Math.round((parseDay(end).getTime() - parseDay(start).getTime()) / MS_DAY));
}

/** Calendar days the trip touches, counting both ends (Nov 10 to Nov 15 is 6 days). */
export function tripDayCount(start: string, end: string): number {
  return nightsBetween(start, end) + 1;
}

const monthDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const dayOnly = new Intl.DateTimeFormat("en-US", { day: "numeric", timeZone: "UTC" });
const weekdayMonthDay = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

/** "Nov 10 to 15", "Nov 28 to Dec 2", with the year added when it isn't the current one. */
export function formatDateRange(start: string, end: string, now: Date = new Date()): string {
  const s = parseDay(start);
  const e = parseDay(end);
  const sameMonth = s.getUTCFullYear() === e.getUTCFullYear() && s.getUTCMonth() === e.getUTCMonth();
  const range = sameMonth ? `${monthDay.format(s)} to ${dayOnly.format(e)}` : `${monthDay.format(s)} to ${monthDay.format(e)}`;
  return e.getUTCFullYear() === now.getFullYear() ? range : `${range}, ${e.getUTCFullYear()}`;
}

/** "Tue, Nov 11" for a single trip day. */
export function formatTripDay(day: string): string {
  return weekdayMonthDay.format(parseDay(day));
}

// --- timestamps (shown in the viewer's own time zone) -----------------------

const timeFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" });

export function timeOfDay(iso: string): string {
  return timeFmt.format(new Date(iso));
}

/** Local calendar day as YYYY-MM-DD, used to group history by day. */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

export function dayHeading(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (dayKey(iso) === dayKey(now.toISOString())) return "Today";
  const yesterday = new Date(now.getTime() - MS_DAY);
  if (dayKey(iso) === dayKey(yesterday.toISOString())) return "Yesterday";
  return dayFmt.format(d);
}

export function timeAgo(iso: string, now: number = Date.now()): string {
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return "Just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return dayFmt.format(new Date(iso));
}

export function errorMessage(err: unknown, fallback = "Something went wrong. Try again."): string {
  return err instanceof Error && err.message ? err.message : fallback;
}
