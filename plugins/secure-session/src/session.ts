import type { SessionData } from "./codec.js";

/** A per-request session backed entirely by an encrypted cookie. */
export interface Session {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): this;
  delete(key: string): this;
  has(key: string): boolean;
  /** drop every key; a fresh cookie is written on the response */
  regenerate(): this;
  /** clear the session and remove the cookie */
  destroy(): void;
  readonly data: Readonly<SessionData>;
}

export class CookieSession implements Session {
  #data: SessionData;
  /** loaded from a valid cookie (vs. a brand-new session) */
  readonly loaded: boolean;
  dirty = false;
  destroyed = false;

  constructor(data: SessionData | null) {
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
    this.#data = {};
    this.dirty = true;
    return this;
  }

  destroy(): void {
    this.#data = {};
    this.destroyed = true;
    this.dirty = false;
  }

  get data(): Readonly<SessionData> {
    return this.#data;
  }
}
