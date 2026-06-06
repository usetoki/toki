export type BreakerState = "closed" | "open" | "half-open";

export interface BreakerConfig {
  /** Fraction of failures (0–1) over the window that trips the breaker. */
  failureThreshold: number;
  /** Don't trip until at least this many calls have been seen in the window. */
  minimumRequests: number;
  /** Rolling window for the failure rate, in ms. */
  windowMs: number;
  /** How long to stay open before letting a single probe through. */
  resetTimeoutMs: number;
  /** Clock; injected so the state machine is deterministic under test. */
  now: () => number;
  onOpen?: (() => void) | undefined;
  onClose?: (() => void) | undefined;
  onHalfOpen?: (() => void) | undefined;
}

/**
 * A failure-rate circuit breaker. `closed` lets calls through and counts outcomes over a
 * rolling window; it trips to `open` once the failure rate crosses the threshold (with a
 * minimum volume so a couple of early errors don't open it). `open` rejects calls until
 * the reset timeout elapses, then a single `half-open` probe decides: success closes it,
 * failure re-opens it. Pure logic — no timers, no I/O.
 */
export class Breaker {
  #state: BreakerState = "closed";
  #failures = 0;
  #total = 0;
  #windowEnd: number;
  #openUntil = 0;
  #probing = false;

  constructor(private readonly config: BreakerConfig) {
    this.#windowEnd = config.now() + config.windowMs;
  }

  get state(): BreakerState {
    return this.#state;
  }

  /** Whether a call may proceed now. Promotes `open` → `half-open` once the cooldown passes. */
  allow(): boolean {
    if (this.#state === "open") {
      if (this.config.now() < this.#openUntil) return false;
      this.#state = "half-open";
      this.#probing = true;
      this.config.onHalfOpen?.();
      return true;
    }
    if (this.#state === "half-open") {
      // one probe at a time — everyone else fast-fails until it resolves
      if (this.#probing) return false;
      this.#probing = true;
      return true;
    }
    return true;
  }

  /** Seconds until the next probe is allowed; 0 unless open. */
  cooldownSeconds(): number {
    if (this.#state !== "open") return 0;
    return Math.max(0, Math.ceil((this.#openUntil - this.config.now()) / 1000));
  }

  success(): void {
    if (this.#state === "half-open") {
      this.#close();
      return;
    }
    this.#roll();
    this.#total += 1;
  }

  failure(): void {
    if (this.#state === "half-open") {
      this.#open();
      return;
    }
    this.#roll();
    this.#total += 1;
    this.#failures += 1;
    if (
      this.#total >= this.config.minimumRequests &&
      this.#failures / this.#total >= this.config.failureThreshold
    ) {
      this.#open();
    }
  }

  // start a fresh window once the current one has elapsed
  #roll(): void {
    const now = this.config.now();
    if (now >= this.#windowEnd) {
      this.#failures = 0;
      this.#total = 0;
      this.#windowEnd = now + this.config.windowMs;
    }
  }

  #open(): void {
    this.#state = "open";
    this.#openUntil = this.config.now() + this.config.resetTimeoutMs;
    this.#probing = false;
    this.config.onOpen?.();
  }

  #close(): void {
    this.#state = "closed";
    this.#failures = 0;
    this.#total = 0;
    this.#probing = false;
    this.#windowEnd = this.config.now() + this.config.windowMs;
    this.config.onClose?.();
  }
}
