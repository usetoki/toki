import { reply } from "@usetoki/toki";
import type { StreamResponse, TokiRequest } from "@usetoki/toki";
import { Channel } from "./channel.js";
import { formatEvent, type SseEvent } from "./format.js";

export interface SseStream {
  /** Send an event. A bare string is shorthand for `{ data }`. */
  send(event: SseEvent | string): void;
  /** Send a comment line (`: …`) — a manual keep-alive or marker. */
  comment(text?: string): void;
  /** End the stream. */
  close(): void;
  /** The client's `Last-Event-ID` on reconnect, or `null` — resume from here. */
  readonly lastEventId: string | null;
  /** Aborts when the client disconnects or the stream ends — stop producing on it. */
  readonly signal: AbortSignal;
}

export interface SseOptions {
  /** Heartbeat comment interval, ms, to keep the connection alive. Default `15000`; `0` disables. */
  heartbeatMs?: number;
  /** Extra response headers. */
  headers?: ReadonlyArray<readonly [string, string]>;
}

/**
 * Open a Server-Sent Events stream. The `producer` receives a handle to `send` events
 * (with optional `id`/`event`/`retry`), read the client's `lastEventId` to resume, and a
 * `signal` that aborts on disconnect. A heartbeat comment keeps proxies from idling the
 * connection. When the producer returns, or the client disconnects, the stream closes and
 * the heartbeat is cleared.
 *
 * ```ts
 * app.get("/feed", (req) => sse(req, async (s) => {
 *   for await (const item of feed(s.lastEventId)) {
 *     if (s.signal.aborted) break;
 *     s.send({ id: item.id, data: item });
 *   }
 * }));
 * ```
 */
export function sse(
  req: TokiRequest,
  producer: (stream: SseStream) => void | Promise<void>,
  options: SseOptions = {},
): StreamResponse {
  const channel = new Channel<string>();
  const aborter = new AbortController();
  const heartbeatMs = options.heartbeatMs ?? 15_000;

  const stream: SseStream = {
    lastEventId: req.headers.get("last-event-id"),
    signal: aborter.signal,
    send: (event) => channel.push(formatEvent(typeof event === "string" ? { data: event } : event)),
    comment: (text = "") => channel.push(`:${text}\n\n`),
    close: () => channel.close(),
  };

  async function* source(): AsyncGenerator<string> {
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    if (heartbeatMs > 0) {
      heartbeat = setInterval(() => channel.push(":\n\n"), heartbeatMs);
      heartbeat.unref?.();
    }
    void Promise.resolve(producer(stream)).then(
      () => channel.close(),
      (error: unknown) => {
        req.log.error("sse producer failed", { error: String(error) });
        channel.close();
      },
    );
    try {
      for await (const frame of channel) yield frame;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      aborter.abort();
      channel.close();
    }
  }

  return reply.stream(source(), {
    contentType: "text/event-stream",
    // Connection is hop-by-hop and set by the server — emitting it here just duplicates it.
    headers: [["Cache-Control", "no-cache"], ...(options.headers ?? [])],
  });
}
