import { useCallback, useEffect, useState } from "react";
import { BASE_URL, api } from "../api.ts";
import { useData } from "../data.tsx";
import { useToast } from "../toast.tsx";
import { Ribbon, StatusPill } from "../components/bits.tsx";

type Check = { state: "checking" } | { state: "ok"; agent: boolean } | { state: "down" };

export function Support() {
  const toast = useToast();
  const { trips } = useData();
  const [check, setCheck] = useState<Check>({ state: "checking" });

  const run = useCallback(() => {
    setCheck({ state: "checking" });
    api
      .health()
      .then((h) => setCheck({ state: "ok", agent: Boolean(h.agent) }))
      .catch(() => setCheck({ state: "down" }));
  }, []);
  useEffect(run, [run]);

  async function copyDiagnostics() {
    const text = [
      `API: ${BASE_URL}`,
      `API status: ${check.state === "ok" ? "reachable" : check.state === "down" ? "unreachable" : "checking"}`,
      `AI agent: ${check.state === "ok" ? (check.agent ? "available" : "not configured") : "unknown"}`,
      `Events: ${trips.length}`,
      `Browser: ${navigator.userAgent}`,
      `Time: ${new Date().toISOString()}`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast("Diagnostics copied. Paste them to your team.", "success");
    } catch {
      toast("Couldn't copy. Allow clipboard access and try again.", "warning");
    }
  }

  return (
    <>
      <Ribbon>Support</Ribbon>

      <section className="panel" aria-labelledby="status-h">
        <h2 id="status-h">System status</h2>
        <ul className="notes">
          <li>
            {check.state === "checking" && <StatusPill tone="neutral">Checking</StatusPill>}
            {check.state === "ok" && <StatusPill tone="green">Connected</StatusPill>}
            {check.state === "down" && <StatusPill tone="red">Not reachable</StatusPill>}
            <span>
              Trip Agent API at <code>{BASE_URL}</code>
            </span>
          </li>
          {check.state === "ok" && (
            <li>
              <StatusPill tone={check.agent ? "green" : "neutral"}>{check.agent ? "On" : "Off"}</StatusPill>
              <span>{check.agent ? "AI agent planning is available." : "AI agent planning is off, so the fast optimizer plans trips. Add an Anthropic key to turn it on."}</span>
            </li>
          )}
        </ul>
        {check.state === "down" && <p>Start the API with <code>npm run dev</code> in the project folder, then check again.</p>}
        <div className="ticket-actions">
          <button type="button" className="btn btn-ink" onClick={run}>
            Check again
          </button>
          <button type="button" className="btn btn-light" onClick={copyDiagnostics}>
            Copy diagnostics
          </button>
        </div>
      </section>

      <section className="panel" aria-labelledby="how-h">
        <h2 id="how-h">How approvals work</h2>
        <ul className="plain">
          <li>The agent only proposes bookings. Nothing is bought until you approve it.</li>
          <li>Before paying, the agent checks the price again. If it changed, it stops and makes a new plan.</li>
          <li>Payments above your spending rules wait for your signature on the event page.</li>
          <li>The sandbox never moves real money.</li>
        </ul>
      </section>
    </>
  );
}
