import { useEffect, useState } from "react";

/**
 * A tiny hash router: the URL hash is the only source of truth for which
 * screen is showing, so a refresh or a shared link lands on the same place.
 *
 *   #/                      events (add ?type=flight to filter)
 *   #/event/<id>            one event
 *   #/new  #/wallet  #/history  #/notifications  #/support
 */
export interface Route {
  segments: string[];
  query: URLSearchParams;
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const [path = "", search = ""] = raw.split("?");
  return {
    segments: path.split("/").filter(Boolean).map(decodeURIComponent),
    query: new URLSearchParams(search),
  };
}

export function navigate(to: string): void {
  window.location.hash = to;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function eventHref(tripId: string): string {
  return `#/event/${encodeURIComponent(tripId)}`;
}
