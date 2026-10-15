import { useEffect, useState } from "react";
import type { Trip } from "@solagent/api";
import { api } from "../api.ts";
import { useData } from "../data.tsx";
import { errorMessage } from "../lib/format.ts";

/** Full trips (with their event logs) for History and Notifications. */
export function useAllTrips() {
  const { trips: summaries, loading } = useData();
  const [trips, setTrips] = useState<Trip[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  // Refetch when the list changes in a way that matters (a new trip, or any trip's version/last event).
  const stamp = summaries.map((s) => `${s.id}:${s.version}:${s.lastEvent?.at ?? ""}:${s.pendingSignatures}`).join("|");

  useEffect(() => {
    if (loading) return;
    let live = true;
    Promise.all(summaries.map((s) => api.getTrip(s.id)))
      .then((all) => {
        if (!live) return;
        setTrips(all);
        setError(null);
        setReady(true);
      })
      .catch((err) => {
        if (!live) return;
        setError(errorMessage(err, "Can't reach the Trip Agent API."));
        setReady(true);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp, loading]);

  return { trips, error, ready: ready && !loading };
}
