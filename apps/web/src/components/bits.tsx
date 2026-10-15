import { useEffect, useRef, type ReactNode } from "react";
import type { Cents } from "@solagent/shared";
import type { Tone } from "../lib/events.ts";
import { formatUsd } from "../lib/format.ts";
import { CloseIcon } from "../icons.tsx";

/** The folded yellow banner that names each screen. */
export function Ribbon({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h1 className="ribbon" id={id}>
      <span>{children}</span>
    </h1>
  );
}

export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

/**
 * Paid / planned / cap as a route line: the solid stretch is money already
 * spent, the lighter stretch is planned but not yet paid, and the end dot is
 * the cap. It turns coral when the plan is over the cap.
 */
export function BudgetRoute({ paid, planned, cap, compact }: { paid: Cents; planned: Cents; cap: Cents; compact?: boolean }) {
  const scale = Math.max(cap, planned, 1);
  const paidPct = Math.min(100, (paid / scale) * 100);
  const plannedPct = Math.min(100, (planned / scale) * 100);
  const capPct = (cap / scale) * 100;
  const over = planned > cap;
  return (
    <div className={`route${compact ? " route-compact" : ""}${over ? " route-over" : ""}`}>
      <div className="route-track" role="img" aria-label={`Paid ${formatUsd(paid)}, planned ${formatUsd(planned)}, cap ${formatUsd(cap)}`}>
        <div className="route-planned" style={{ width: `${plannedPct}%` }} />
        <div className="route-paid" style={{ width: `${paidPct}%` }} />
        <span className="route-cap" style={{ left: `${capPct}%` }} />
      </div>
      <dl className="route-figures">
        <div>
          <dt>Paid</dt>
          <dd>{formatUsd(paid)}</dd>
        </div>
        <div>
          <dt>Planned</dt>
          <dd>{formatUsd(planned)}</dd>
        </div>
        <div>
          <dt>Cap</dt>
          <dd>{formatUsd(cap)}</dd>
        </div>
      </dl>
      {over && <p className="route-warning">Planned spending is {formatUsd(planned - cap)} over the cap.</p>}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children && <p className="empty-body">{children}</p>}
      {action}
    </div>
  );
}

export function Banner({ tone, children, action }: { tone: "error" | "warning" | "info"; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={`banner banner-${tone}`} role={tone === "error" ? "alert" : undefined}>
      <div>{children}</div>
      {action}
    </div>
  );
}

/** A modal built on <dialog>, so focus trapping and Escape come from the browser. */
export function Modal({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog ref={ref} className="modal" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()} aria-label={title}>
      {open && (
        <div className="modal-card">
          <div className="modal-head">
            <h2>{title}</h2>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
              <CloseIcon size={18} />
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}
