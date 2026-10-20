import { useState, type FormEvent } from "react";
import { useData } from "../data.tsx";
import { useToast } from "../toast.tsx";
import { Banner, Modal, Ribbon } from "../components/bits.tsx";
import { formatUsd, dayHeading, timeOfDay } from "../lib/format.ts";
import { shortAddress, useDemoWallet } from "../wallet.ts";
import { ArrowDownIcon, ArrowUpIcon, CopyIcon } from "../icons.tsx";

export function Wallet() {
  const { trips } = useData();
  const toast = useToast();
  const { wallet, apply } = useDemoWallet();
  const [mode, setMode] = useState<"topup" | "withdraw" | null>(null);
  const [amount, setAmount] = useState("100");
  const [err, setErr] = useState<string | null>(null);

  const paid = trips.reduce((s, t) => s + t.paidCents, 0);
  const waiting = trips.reduce((s, t) => s + t.openBookingsCents, 0);
  const afterBookings = wallet.balanceCents - waiting;

  function submit(e: FormEvent) {
    e.preventDefault();
    const dollars = Number(amount);
    if (!mode) return;
    if (!Number.isFinite(dollars) || dollars <= 0) return setErr("Enter an amount above $0.");
    const problem = apply(mode, Math.round(dollars * 100));
    if (problem) return setErr(problem);
    toast(mode === "topup" ? `Added ${formatUsd(Math.round(dollars * 100))} to the wallet.` : `Withdrew ${formatUsd(Math.round(dollars * 100))}.`, "success");
    setMode(null);
    setErr(null);
  }

  function open(next: "topup" | "withdraw") {
    setAmount("100");
    setErr(null);
    setMode(next);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(wallet.address);
      toast("Wallet address copied.", "success");
    } catch {
      toast("Couldn't copy. Select the address and copy it by hand.", "warning");
    }
  }

  return (
    <>
      <Ribbon>Fund Wallet</Ribbon>
      <Banner tone="info">
        Demo wallet. The balance below is a pretend balance saved in this browser. Real top-ups and withdrawals arrive with the Solana payments layer. The "Paid" and "Waiting to be booked" figures come from your real events.
      </Banner>

      <section className="panel wallet" aria-label="Wallet">
        <div className="address">
          <code title={wallet.address}>{shortAddress(wallet.address)}</code>
          <button type="button" className="icon-btn" onClick={copy} aria-label="Copy wallet address">
            <CopyIcon size={18} />
          </button>
        </div>
        <p className="balance-label">Balance</p>
        <p className="balance">{formatUsd(wallet.balanceCents)}</p>
        <div className="ticket-actions center">
          <button type="button" className="btn btn-ink" onClick={() => open("topup")}>
            <ArrowDownIcon size={16} /> Top Up Wallet
          </button>
          <button type="button" className="btn btn-light" onClick={() => open("withdraw")}>
            <ArrowUpIcon size={16} /> Withdraw Balance
          </button>
        </div>
        <dl className="facts facts-row">
          <div>
            <dt>Paid for trips</dt>
            <dd>{formatUsd(paid)}</dd>
          </div>
          <div>
            <dt>Waiting to be booked</dt>
            <dd>{formatUsd(waiting)}</dd>
          </div>
          <div>
            <dt>Left after those bookings</dt>
            <dd className={afterBookings < 0 ? "neg" : undefined}>{formatUsd(afterBookings)}</dd>
          </div>
        </dl>
        {afterBookings < 0 && <p className="route-warning">Your open bookings are {formatUsd(-afterBookings)} more than the wallet holds. Top up before you approve them.</p>}
      </section>

      <section className="panel" aria-labelledby="tx-h">
        <h2 id="tx-h">Wallet activity</h2>
        {wallet.txs.length === 0 ? (
          <p className="muted">Top-ups and withdrawals will show here.</p>
        ) : (
          <ol className="log">
            {wallet.txs.map((t) => (
              <li key={t.id}>
                <time dateTime={t.at}>
                  {dayHeading(t.at)}, {timeOfDay(t.at)}
                </time>
                <span>
                  {t.kind === "topup" ? "Added" : "Withdrew"} {formatUsd(t.cents)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <Modal open={mode !== null} title={mode === "topup" ? "Top up wallet" : "Withdraw balance"} onClose={() => setMode(null)}>
        <form onSubmit={submit} noValidate>
          <div className={`field${err ? " field-error" : ""}`}>
            <label htmlFor="wallet-amount">Amount (USD)</label>
            <input id="wallet-amount" type="number" inputMode="decimal" min={1} step="any" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={err ? true : undefined} aria-describedby={err ? "wallet-err" : undefined} autoFocus />
            {err && (
              <p id="wallet-err" className="field-note err">
                {err}
              </p>
            )}
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-light" onClick={() => setMode(null)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-ink">
              {mode === "topup" ? "Add to wallet" : "Withdraw"}
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}
