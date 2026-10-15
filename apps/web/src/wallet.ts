import { useCallback, useEffect, useState } from "react";
import type { Cents } from "@solagent/shared";

/**
 * DEMO WALLET. The backend has no wallet balance, top-up or withdrawal yet
 * (that belongs to the payments layer), so this screen keeps a pretend
 * balance in the browser's localStorage. Everything that reads "paid" or
 * "waiting to be booked" elsewhere comes from the real API.
 */
const KEY = "trip-agent:demo-wallet";

export interface WalletTx {
  id: string;
  at: string;
  kind: "topup" | "withdraw";
  cents: Cents;
}

export interface DemoWallet {
  address: string;
  balanceCents: Cents;
  txs: WalletTx[];
}

function randomAddress(): string {
  const chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const bytes = new Uint8Array(44);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

function load(): DemoWallet {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as DemoWallet;
      if (typeof parsed.address === "string" && Number.isFinite(parsed.balanceCents) && Array.isArray(parsed.txs)) return parsed;
    }
  } catch {
    /* fall through to a fresh wallet */
  }
  return { address: randomAddress(), balanceCents: 300_00, txs: [] };
}

export function shortAddress(address: string): string {
  return address.length > 14 ? `${address.slice(0, 6)}...${address.slice(-6)}` : address;
}

export function useDemoWallet() {
  const [wallet, setWallet] = useState<DemoWallet>(load);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(wallet));
    } catch {
      /* storage blocked: the balance lasts until the tab closes */
    }
  }, [wallet]);

  const balanceCents = wallet.balanceCents;
  const apply = useCallback(
    (kind: WalletTx["kind"], cents: Cents): string | null => {
      if (kind === "withdraw" && cents > balanceCents) return "That's more than the balance.";
      const tx: WalletTx = { id: crypto.randomUUID(), at: new Date().toISOString(), kind, cents };
      setWallet((w) => ({
        ...w,
        balanceCents: w.balanceCents + (kind === "topup" ? cents : -cents),
        txs: [tx, ...w.txs].slice(0, 50),
      }));
      return null;
    },
    [balanceCents],
  );

  return { wallet, apply };
}
