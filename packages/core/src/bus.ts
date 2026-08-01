import { EventEmitter } from "node:events";
import { HarnessEvent } from "@harness/shared";
import { Store } from "./store.js";

/**
 * Write-ahead event bus: persist to SQLite first (with optional materialized-state
 * update in the same transaction), then emit in-memory for live subscribers.
 */
export class Bus {
  private emitter = new EventEmitter();

  constructor(private store: Store) {
    this.emitter.setMaxListeners(100);
  }

  publish(ev: HarnessEvent, materialize?: () => void): number {
    const seq = this.store.appendEvent(ev, materialize);
    this.emitter.emit("event", { seq, event: ev });
    return seq;
  }

  subscribe(fn: (e: { seq: number; event: HarnessEvent }) => void): () => void {
    this.emitter.on("event", fn);
    return () => this.emitter.off("event", fn);
  }
}
