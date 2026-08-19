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
    // Every append is emitted, however it got there. State transitions go straight
    // through the store rather than through publish(), and before this they were
    // recorded but never seen live — no `▶ state` lines, no dashboard update.
    this.store.onAppend((e) => this.emitter.emit("event", e));
  }

  publish(ev: HarnessEvent, materialize?: () => void): number {
    return this.store.appendEvent(ev, materialize);
  }

  subscribe(fn: (e: { seq: number; event: HarnessEvent }) => void): () => void {
    this.emitter.on("event", fn);
    return () => this.emitter.off("event", fn);
  }

  /**
   * How many live subscribers are attached right now. A test that publishes
   * into a stream it just opened needs to know the subscription is real before
   * it publishes — a fixed sleep only pretends to.
   */
  get subscribers(): number {
    return this.emitter.listenerCount("event");
  }
}
