/**
 * A push→pull bridge. Producers `push` values; the async iterator pulls them, suspending
 * when the queue is empty and resuming on the next push. `close` ends iteration. Used to
 * feed an event-driven producer into the framework's pull-based stream driver.
 */
export class Channel<T> {
  readonly #queue: T[] = [];
  readonly #maxQueue: number;
  #pending: ((result: IteratorResult<T>) => void) | null = null;
  #closed = false;

  /** `maxQueue` bounds memory when the consumer is slower than the producer; the oldest
   *  buffered value is dropped past it. Default 1024. */
  constructor(maxQueue = 1024) {
    this.#maxQueue = maxQueue;
  }

  push(value: T): void {
    if (this.#closed) return;
    if (this.#pending !== null) {
      const resolve = this.#pending;
      this.#pending = null;
      resolve({ value, done: false });
    } else {
      if (this.#queue.length >= this.#maxQueue) this.#queue.shift(); // drop oldest, never grow unbounded
      this.#queue.push(value);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#pending !== null) {
      const resolve = this.#pending;
      this.#pending = null;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const queued = this.#queue.shift();
        if (queued !== undefined) return Promise.resolve({ value: queued, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.#pending = resolve;
        });
      },
      // called when the consumer stops early (client disconnect)
      return: (): Promise<IteratorResult<T>> => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
