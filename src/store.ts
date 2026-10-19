import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ChatState, Order } from "./types.js";

// One JSON file, written atomically (temp file + rename). Every change runs in
// `transaction()`: memory is changed, the file is written, and only then does
// the caller go on (answer send21 with 2xx, call send21, message the buyer).
// If the write fails, the state is reloaded from disk and the error is thrown.
// transaction() is synchronous, so a stock check and its reservation cannot
// interleave with another checkout. Good for one process; for several, use
// SQLite or Postgres (see send21-examples/examples/webhook-receiver-sqlite).

export interface StoreData {
  version: 1;
  /** Next order number for people ("#12"). */
  seq: number;
  orders: Record<string, Order>;
  chats: Record<string, ChatState>;
  /** X-Send21-Delivery id -> first seen (ms) */
  deliveries: Record<string, number>;
  /** sha256 of the raw body -> first seen (ms): the same event under a new delivery id */
  events: Record<string, number>;
}

const empty = (): StoreData => ({ version: 1, seq: 0, orders: {}, chats: {}, deliveries: {}, events: {} });
const KEEP_MS = 30 * 24 * 3600_000;

export class Store {
  private data: StoreData;

  constructor(private readonly file: string) {
    this.data = this.load();
  }

  private load(): StoreData {
    if (this.file === ":memory:" || !existsSync(this.file)) return empty();
    return { ...empty(), ...(JSON.parse(readFileSync(this.file, "utf8")) as Partial<StoreData>), version: 1 };
  }

  private persist(): void {
    if (this.file === ":memory:") return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** Run fn against the data and write it. All or nothing. fn must be synchronous. */
  transaction<T>(fn: (d: StoreData) => T): T {
    try {
      const result = fn(this.data);
      this.persist();
      return result;
    } catch (err) {
      this.data = this.load();
      throw err;
    }
  }

  read<T>(fn: (d: Readonly<StoreData>) => T): T {
    return fn(this.data);
  }

  getOrder(id: string): Order | undefined {
    return this.data.orders[id];
  }

  /** Record a webhook delivery. False when the delivery id or the exact same body was already handled. */
  static remember(d: StoreData, deliveryId: string, eventKey: string, now = Date.now()): boolean {
    if (d.deliveries[deliveryId] || d.events[eventKey]) return false;
    d.deliveries[deliveryId] = now;
    d.events[eventKey] = now;
    for (const map of [d.deliveries, d.events]) for (const [k, t] of Object.entries(map)) if (now - t > KEEP_MS) delete map[k];
    return true;
  }
}
