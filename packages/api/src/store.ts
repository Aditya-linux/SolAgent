import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { Trip } from "./trips.ts";

/**
 * Persistence for trips. `TripService` only ever needs these three operations
 * and they're all synchronous, so swapping stores never changes its call
 * sites. `InMemoryTripStore` is the default (and what the existing tests use
 * implicitly); `SqliteTripStore` is what the real server uses so trips survive
 * a restart.
 *
 * A trip (plan, envelopes, items, offers, history, events, candidates) is
 * stored as one JSON blob per row rather than normalized into columns. For
 * this MVP nothing needs to query *inside* a trip from SQL — the app always
 * loads a whole trip and works with it in memory, the same way it does today
 * with the in-memory Map. If that changes (e.g. "find all items booked with
 * supplier X across every trip"), that's the point to add real columns or a
 * child table for the data that needs to be queried, not before.
 */
export interface TripStore {
  list(): Trip[];
  get(id: string): Trip | undefined;
  /** Insert or fully replace the stored snapshot for `trip.id`. */
  save(trip: Trip): void;
}

export class InMemoryTripStore implements TripStore {
  private readonly trips = new Map<string, Trip>();

  list(): Trip[] {
    return [...this.trips.values()];
  }

  get(id: string): Trip | undefined {
    return this.trips.get(id);
  }

  save(trip: Trip): void {
    this.trips.set(trip.id, trip);
  }
}

/**
 * SQLite-backed store using Node's built-in `node:sqlite` module (stable
 * enough for this, and needs no native dependency to build or install —
 * `better-sqlite3` is a fine upgrade later if normalized columns are added).
 */
export class SqliteTripStore implements TripStore {
  private readonly db: DatabaseSync;
  private readonly stmts: {
    upsert: StatementSync;
    getById: StatementSync;
    listAll: StatementSync;
  };

  constructor(filePath: string) {
    if (filePath !== ":memory:") mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trips (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
    `);
    this.stmts = {
      upsert: this.db.prepare(
        `INSERT INTO trips (id, created_at, updated_at, data) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, data = excluded.data`,
      ),
      getById: this.db.prepare("SELECT data FROM trips WHERE id = ?"),
      listAll: this.db.prepare("SELECT data FROM trips ORDER BY created_at ASC"),
    };
  }

  list(): Trip[] {
    const rows = this.stmts.listAll.all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Trip);
  }

  get(id: string): Trip | undefined {
    const row = this.stmts.getById.get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Trip) : undefined;
  }

  save(trip: Trip): void {
    const now = new Date().toISOString();
    this.stmts.upsert.run(trip.id, trip.createdAt, now, JSON.stringify(trip));
  }

  close(): void {
    this.db.close();
  }
}
