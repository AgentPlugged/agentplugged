import { ErrorCode, type EventEnvelope } from "@agentplugged/protocol";
import { AgentPluggedError } from "../errors.js";
import { checkHumanEvents } from "../human/human-events.js";
import { type KeyStore, loadMachineKey } from "./key-store.js";
import {
  deviceHeads,
  journalProduct,
  prepareAppend,
  prepareEngineEvents,
} from "./prepare-event.js";
import {
  adoptRotatedKey,
  announcedKey,
  forgetProductKey,
  hasRotation,
  sensitiveProductKey,
} from "./product-key.js";
import type {
  AppendOptions,
  EventDraft,
  JournalHistory,
  JournalListing,
  RemoteJournalStatus,
  StateStore,
} from "./state-store.js";
import { type Clock, createUlidFactory, type UlidFactory } from "./ulid.js";

const byId = (a: EventEnvelope, b: EventEnvelope) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** `StateStore` in memory (tests): same completion, chaining and signing as the Git journal. */
export class MemoryStateStore implements StateStore {
  /**
   * The events of each generation, in the order they were written: the last one is the journal,
   * the others what `rewrite` replaced. A generation only grows (by `append`).
   */
  readonly #generations: EventEnvelope[][] = [[]];
  readonly #keys: KeyStore;
  readonly #now: Clock;
  readonly #newId: UlidFactory;
  readonly #allowTestTypes: boolean;
  #projected: string | null = null;

  constructor(options: {
    keys: KeyStore;
    now?: Clock;
    newId?: UlidFactory;
    /** Accepts the types reserved to tests (`test.*`). */
    allowTestTypes?: boolean;
  }) {
    this.#keys = options.keys;
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? createUlidFactory({ now: this.#now });
    this.#allowTestTypes = options.allowTestTypes === true;
  }

  /** What `remoteJournalStatus` answers (tests): no remote by default. */
  remote: RemoteJournalStatus = { kind: "no_remote" };
  /** A failure `list()` throws (tests), once set. */
  listFailure: Error | undefined;

  async remoteJournalStatus(): Promise<RemoteJournalStatus> {
    return this.remote;
  }

  /** The journal's events, in the order they were written (read-only: `append`, `rewrite`). */
  get events(): readonly EventEnvelope[] {
    return this.#current();
  }

  #current(): EventEnvelope[] {
    return this.#generations[this.#generations.length - 1] as EventEnvelope[];
  }

  async append(draft: EventDraft): Promise<EventEnvelope> {
    const [event] = await this.appendAll([draft]);
    if (event === undefined) throw new Error("MemoryStateStore: nothing was prepared");
    return event;
  }

  async appendAll(
    drafts: readonly EventDraft[],
    options: AppendOptions = {},
  ): Promise<readonly EventEnvelope[]> {
    if (drafts.length === 0) {
      throw new AgentPluggedError(ErrorCode.UNEXPECTED, "error.unexpected", {
        reason: "no event to append",
      });
    }
    await options.precondition?.(await this.list());
    const key = await loadMachineKey(this.#keys);
    const events = this.#current();
    const product = drafts.find((draft) => draft.payload !== undefined)?.product;
    if (product !== undefined && hasRotation(events)) {
      // A renewal sealed for this machine is taken in before it writes sensitive content.
      await forgetProductKey(
        await adoptRotatedKey(this.#keys, product, {
          events,
          allowTestTypes: this.#allowTestTypes,
        }).catch(() => undefined),
      );
    }
    const productKey = await sensitiveProductKey(this.#keys, drafts);
    try {
      const announced =
        productKey === undefined
          ? null
          : await announcedKey(events, { productKey, allowTestTypes: this.#allowTestTypes });
      const prepared = await prepareAppend({
        ...(productKey === undefined ? {} : { productKey }),
        announced,
        draft: drafts,
        key,
        deviceHead: deviceHeads(events).get(key.device) ?? null,
        journalProduct: journalProduct(events)?.product ?? null,
        newId: this.#newId,
        now: this.#now,
        allowTestTypes: this.#allowTestTypes,
      });
      events.push(...prepared.events);
      return prepared.written;
    } finally {
      await forgetProductKey(productKey);
    }
  }

  async appendHuman(
    human: readonly EventEnvelope[],
    options: AppendOptions = {},
  ): Promise<readonly EventEnvelope[]> {
    await options.precondition?.(await this.list());
    const events = this.#current();
    const first = human[0];
    const heads = deviceHeads(events);
    const product = journalProduct(events)?.product ?? null;
    checkHumanEvents(
      human,
      first === undefined ? null : (heads.get(first.actor.device) ?? null),
      product,
    );
    if (product === null && first !== undefined) {
      const key = await loadMachineKey(this.#keys);
      const engine = await prepareEngineEvents({
        key,
        deviceHead: heads.get(key.device) ?? null,
        journalProduct: null,
        product: first.product,
        newId: this.#newId,
        now: this.#now,
      });
      events.push(...engine.events);
    }
    events.push(...human);
    return [...human];
  }

  /**
   * Replaces every event: a history rewritten by force, or events received by a sync (tests).
   * Positions given before never descend from the new ones.
   */
  rewrite(events: readonly EventEnvelope[]): void {
    this.#generations.push([...events]);
  }

  async list(): Promise<JournalListing> {
    if (this.listFailure !== undefined) throw this.listFailure;
    return { head: this.#position(), events: [...this.#current()].sort(byId), problems: [] };
  }

  /**
   * `memory:<number of events>`, or `memory:<generation>.<number>` after a rewrite: opaque,
   * compared for equality only.
   */
  async head(): Promise<string | null> {
    return this.#position();
  }

  #position(): string | null {
    const count = this.#current().length;
    if (count === 0) return null;
    const generation = this.#generations.length - 1;
    return generation === 0 ? `memory:${count}` : `memory:${generation}.${count}`;
  }

  /** The events held at a position given out, or undefined when it names none. */
  #at(position: string): { generation: number; events: EventEnvelope[] } | undefined {
    const match = /^memory:(?:(\d+)\.)?(\d+)$/.exec(position);
    if (match === null) return undefined;
    const generation = Number(match[1] ?? 0);
    const events = this.#generations[generation];
    const count = Number(match[2]);
    if (events === undefined || count > events.length) return undefined;
    return { generation, events: events.slice(0, count) };
  }

  async productId(): Promise<string | null> {
    return journalProduct(this.#current())?.product ?? null;
  }

  async projected(): Promise<string | null> {
    return this.#projected;
  }

  async markProjected(position: string | null, previous: string | null): Promise<void> {
    if (this.#projected === previous) this.#projected = position;
  }

  async history(from: string, to: string | null): Promise<JournalHistory> {
    const before = this.#at(from);
    if (before === undefined) return { descends: false, missing: 0, unknown: true };
    const after = to === null ? undefined : this.#at(to);
    const held = new Set(after?.events.map((event) => event.id) ?? []);
    const missing = before.events.filter((event) => !held.has(event.id)).length;
    const descends = after !== undefined && after.generation === before.generation;
    return { descends, missing };
  }
}
