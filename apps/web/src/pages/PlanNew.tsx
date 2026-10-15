import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import type { LodgingStyle, Pace } from "@solagent/shared";
import { api } from "../api.ts";
import { useData } from "../data.tsx";
import { useToast } from "../toast.tsx";
import { Banner, Ribbon } from "../components/bits.tsx";
import { AIRPORTS, EVENT_TYPE_OPTIONS, cityForCode } from "../lib/events.ts";
import { errorMessage, formatUsd, plural, tripDayCount } from "../lib/format.ts";
import { defaultPlanForm, perPersonPerDay, validatePlanForm, type PlanFormErrors, type PlanFormState } from "../lib/planForm.ts";
import { eventHref, navigate } from "../lib/router.ts";

const INTERESTS = ["food", "history", "museums", "beaches", "hiking", "nightlife", "shopping", "family"];
const LODGING: Array<{ value: LodgingStyle; label: string }> = [
  { value: "budget", label: "Budget" },
  { value: "standard", label: "Standard" },
  { value: "luxury", label: "Luxury" },
];
const PACES: Array<{ value: Pace; label: string }> = [
  { value: "relaxed", label: "Relaxed" },
  { value: "balanced", label: "Balanced" },
  { value: "packed", label: "Packed" },
];

export function PlanNew() {
  const toast = useToast();
  const { refresh } = useData();
  const [form, setForm] = useState<PlanFormState>(() => defaultPlanForm());
  const [errors, setErrors] = useState<PlanFormErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [agentReady, setAgentReady] = useState(false);
  const airportList = useId();

  useEffect(() => {
    api
      .health()
      .then((h) => setAgentReady(Boolean(h.agent)))
      .catch(() => setAgentReady(false));
  }, []);

  const set = <K extends keyof PlanFormState>(key: K, value: PlanFormState[K]) => setForm((f) => ({ ...f, [key]: value }));
  const toggleInterest = (name: string) =>
    set("interests", form.interests.includes(name) ? form.interests.filter((i) => i !== name) : [...form.interests, name]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const found = validatePlanForm(form);
    setErrors(found);
    setProblem(null);
    if (Object.keys(found).length > 0) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>("[aria-invalid='true']")?.focus());
      return;
    }
    setSubmitting(true);
    try {
      const destination = form.destination.trim().toUpperCase();
      const origin = form.origin.trim().toUpperCase();
      const trip = await api.createTrip({
        eventType: form.eventType,
        origin: origin || undefined,
        destination,
        destinationName: cityForCode(destination),
        startDate: form.startDate,
        endDate: form.endDate,
        travelers: form.travelers,
        budgetUsd: Number(form.budget),
        preferences: {
          lodgingStyle: form.lodgingStyle,
          pace: form.pace,
          interests: form.interests,
          avoid: form.avoid.split(",").map((s) => s.trim()).filter(Boolean),
          notes: form.notes.trim() || undefined,
        },
        mode: agentReady ? form.mode : "optimizer",
      });
      await refresh();
      toast("Your plan is ready. Review it and approve what you like.", "success");
      navigate(eventHref(trip.id).slice(1));
    } catch (err) {
      setProblem(errorMessage(err, "The agent couldn't build a plan. Check the details and try again."));
    } finally {
      setSubmitting(false);
    }
  }

  const daily = perPersonPerDay(form);
  const days = form.startDate && form.endDate && form.endDate > form.startDate ? tripDayCount(form.startDate, form.endDate) : null;

  return (
    <>
      <Ribbon>Plan New Event</Ribbon>
      <form className="panel form" onSubmit={submit} noValidate>
        <fieldset>
          <legend>What kind of event is it?</legend>
          <div className="seg" role="radiogroup">
            {EVENT_TYPE_OPTIONS.map((o) => (
              <label key={o.value} className={form.eventType === o.value ? "seg-on" : undefined}>
                <input type="radio" name="eventType" value={o.value} checked={form.eventType === o.value} onChange={() => set("eventType", o.value)} />
                {o.label}
              </label>
            ))}
          </div>
        </fieldset>

        <datalist id={airportList}>
          {AIRPORTS.map(([code, city]) => (
            <option key={code} value={code}>
              {city}
            </option>
          ))}
        </datalist>

        <div className="grid2">
          <Field label="Flying from" hint="Airport code. Leave empty if you don't need a flight." error={errors.origin}>
            {(p) => <input {...p} list={airportList} value={form.origin} onChange={(e) => set("origin", e.target.value.toUpperCase())} maxLength={3} autoComplete="off" />}
          </Field>
          <Field label="Going to" hint={cityForCode(form.destination) ?? "Airport code, like LIS."} error={errors.destination}>
            {(p) => <input {...p} list={airportList} value={form.destination} onChange={(e) => set("destination", e.target.value.toUpperCase())} maxLength={3} autoComplete="off" />}
          </Field>
          <Field label="Start date" error={errors.startDate}>
            {(p) => <input {...p} type="date" value={form.startDate} onChange={(e) => set("startDate", e.target.value)} />}
          </Field>
          <Field label="End date" error={errors.endDate}>
            {(p) => <input {...p} type="date" value={form.endDate} onChange={(e) => set("endDate", e.target.value)} />}
          </Field>
          <Field label="Travelers" error={errors.travelers}>
            {(p) => <input {...p} type="number" min={1} max={9} value={form.travelers} onChange={(e) => set("travelers", e.target.valueAsNumber)} />}
          </Field>
          <Field
            label="Spending cap (USD)"
            hint={daily !== undefined && days ? `About ${formatUsd(daily * 100)} per person per day over ${plural(days, "day")}.` : "The most the agent may plan to spend."}
            error={errors.budget}
          >
            {(p) => <input {...p} type="number" inputMode="decimal" min={1} step="any" value={form.budget} onChange={(e) => set("budget", e.target.value)} />}
          </Field>
        </div>

        <div className="grid2">
          <fieldset>
            <legend>Where to stay</legend>
            <div className="seg" role="radiogroup">
              {LODGING.map((o) => (
                <label key={o.value} className={form.lodgingStyle === o.value ? "seg-on" : undefined}>
                  <input type="radio" name="lodging" checked={form.lodgingStyle === o.value} onChange={() => set("lodgingStyle", o.value)} />
                  {o.label}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend>Pace</legend>
            <div className="seg" role="radiogroup">
              {PACES.map((o) => (
                <label key={o.value} className={form.pace === o.value ? "seg-on" : undefined}>
                  <input type="radio" name="pace" checked={form.pace === o.value} onChange={() => set("pace", o.value)} />
                  {o.label}
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <fieldset>
          <legend>Interests</legend>
          <div className="seg seg-wrap">
            {INTERESTS.map((name) => (
              <label key={name} className={form.interests.includes(name) ? "seg-on" : undefined}>
                <input type="checkbox" checked={form.interests.includes(name)} onChange={() => toggleInterest(name)} />
                {name[0]!.toUpperCase() + name.slice(1)}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="grid2">
          <Field label="Things to avoid" hint="Separate with commas, like red-eye flights, hostels.">
            {(p) => <input {...p} value={form.avoid} onChange={(e) => set("avoid", e.target.value)} />}
          </Field>
          <Field label="Anything else the agent should know">
            {(p) => <input {...p} value={form.notes} onChange={(e) => set("notes", e.target.value)} />}
          </Field>
        </div>

        {agentReady && (
          <label className="check">
            <input type="checkbox" checked={form.mode === "agent"} onChange={(e) => set("mode", e.target.checked ? "agent" : "optimizer")} />
            Let the AI agent write the plan (slower, uses your notes). Otherwise the fast optimizer plans it.
          </label>
        )}

        {problem && <Banner tone="error">{problem}</Banner>}

        <div className="form-actions">
          <button type="submit" className="btn btn-ink btn-big" disabled={submitting}>
            {submitting ? "Planning…" : "Plan this event"}
          </button>
          <a className="btn btn-light btn-big" href="#/">
            Cancel
          </a>
        </div>
      </form>
    </>
  );
}

type InputProps = { id: string; "aria-invalid": boolean | undefined; "aria-describedby": string | undefined };

function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: (props: InputProps) => ReactNode }) {
  const id = useId();
  const noteId = `${id}-note`;
  return (
    <div className={`field${error ? " field-error" : ""}`}>
      <label htmlFor={id}>{label}</label>
      {children({ id, "aria-invalid": error ? true : undefined, "aria-describedby": error || hint ? noteId : undefined })}
      {(error || hint) && (
        <p id={noteId} className={error ? "field-note err" : "field-note"}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}
