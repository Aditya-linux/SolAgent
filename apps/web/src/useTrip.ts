import { useCallback, useEffect, useRef, useState } from "react";
import type { Trip } from "@solagent/api";
import { api, subscribeToTripEvents } from "./api.ts";
import { errorMessage } from "./lib/format.ts";

/** One trip, kept fresh by the server's live event stream. */
export function useTrip(tripId: string) {
  const [trip, setTrip] = useState<Trip | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const refetch = useCallback(async () => {
    try {
      const next = await api.getTrip(tripId);
      if (!alive.current) return;
      setTrip(next);
      setError(null);
    } catch (err) {
      if (alive.current) setError(errorMessage(err, "Can't reach the Trip Agent API."));
    }
  }, [tripId]);

  useEffect(() => {
    alive.current = true;
    setTrip(null);
    void refetch();
    const stop = subscribeToTripEvents(tripId, () => void refetch());
    return () => {
      alive.current = false;
      stop();
    };
  }, [tripId, refetch]);

  return { trip, error, refetch };
}
