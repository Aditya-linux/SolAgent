import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TripSummary } from "@solagent/api";
import { api } from "./api.ts";
import { errorMessage } from "./lib/format.ts";
import { isAlert } from "./lib/events.ts";

const POLL_MS = 8000;
const SEEN_KEY = "trip-agent:alerts-seen-at";

interface DataValue {
  trips: TripSummary[];
  /** True until the first response (or failure) arrives. */
  loading: boolean;
  /** Set when the API can't be reached; cleared by the next good response. */
  error: string | null;
  refresh: () => Promise<void>;
  /** Alerts and signatures that need a look, for the badge on Notifications. */
  unreadCount: number;
  markAlertsSeen: () => void;
}

const DataContext = createContext<DataValue | null>(null);

function readSeen(): string {
  try {
    return localStorage.getItem(SEEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function DataProvider({ children }: { children: ReactNode }) {
  const [trips, setTrips] = useState<TripSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [seenAt, setSeenAt] = useState<string>(readSeen);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const list = await api.listTrips();
      if (!alive.current) return;
      setTrips(list);
      setError(null);
    } catch (err) {
      if (!alive.current) return;
      setError(errorMessage(err, "Can't reach the Trip Agent API."));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const markAlertsSeen = useCallback(() => {
    const now = new Date().toISOString();
    setSeenAt(now);
    try {
      localStorage.setItem(SEEN_KEY, now);
    } catch {
      /* private mode: the badge just resets on reload */
    }
  }, []);

  const unreadCount = useMemo(() => {
    let count = 0;
    for (const t of trips) {
      count += t.pendingSignatures;
      if (t.lastEvent && isAlert(t.lastEvent.type) && t.lastEvent.at > seenAt) count += 1;
    }
    return count;
  }, [trips, seenAt]);

  const value = useMemo(
    () => ({ trips, loading, error, refresh, unreadCount, markAlertsSeen }),
    [trips, loading, error, refresh, unreadCount, markAlertsSeen],
  );
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData(): DataValue {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error("useData must be used inside DataProvider");
  return ctx;
}
