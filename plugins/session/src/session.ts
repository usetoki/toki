import { newSessionId } from "./id.js";
import type { SessionData } from "./store.js";

export interface Session {
  readonly id: string;
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): this;
  delete(key: string): this;
  has(key: string): boolean;
  /** rotate to a fresh id and empty the data — call right after login to stop fixation */
  regenerate(): this;
  /** drop the session from the store and clear the cookie */
  destroy(): void;
  readonly data: Readonly<SessionData>;
}

export class StoredSession implements Session {
  id: string;
  /** loaded from the store, vs. a brand-new session */
  readonly loaded: boolean;
  /** the stored id to drop after a regenerate, else null */
  oldId: string | null = null;
  dirty = false;
  destroyed = false;
  #data: SessionData;

  constructor(id: string, data: SessionData | null) {
    this.id = id;
    this.loaded = data !== null;
    this.#data = data ?? {};
  }

  get<T = unknown>(key: string): T | undefined {
    return this.#data[key] as T | undefined;
  }

  set(key: string, value: unknown): this {
    this.#data[key] = value;
    this.dirty = true;
    return this;
  }

  delete(key: string): this {
    if (key in this.#data) {
      delete this.#data[key];
      this.dirty = true;
    }
    return this;
  }

  has(key: string): boolean {
    return key in this.#data;
  }

  regenerate(): this {
    if (this.oldId === null && this.loaded) this.oldId = this.id;
    this.id = newSessionId();
    this.#data = {};
    this.dirty = true;
    return this;
  }

  destroy(): void {
    this.destroyed = true;
    this.dirty = false;
  }

  get data(): Readonly<SessionData> {
    return this.#data;
  }
}
