import type { DocPage } from "../../types";

export const websocketsPage: DocPage = {
  slug: "websockets",
  title: "WebSockets",
  description: "Full RFC 6455 WebSockets with native framing, events, and permessage-deflate.",
  blocks: [
    {
      kind: "paragraph",
      text: "`app.ws(path, handler)` registers a WebSocket endpoint. The handshake, framing, masking, fragmentation, ping/pong, and close handshake all run in native code, so your handler only ever sees complete messages. You get a `TokiWebSocket` per connection and a `TokiRequest` for the upgrade. Attach listeners on the socket and you are live.",
    },
    {
      kind: "paragraph",
      text: "Reach for WebSockets when both sides talk: chat, multiplayer, collaborative editing, live dashboards with client input. If you only push to the browser (prices, logs, notifications), [Server-Sent Events](/docs/plugin-sse) reconnect on their own and ride a plain HTTP connection.",
    },
    { kind: "heading", id: "echo", text: "An echo endpoint" },
    {
      kind: "paragraph",
      text: "The two-argument form takes a path and a handler. `socket.send` accepts a `string` (sent as text) or a `Uint8Array` (sent as binary); the `message` event reports which arrived via `isBinary`.",
    },
    {
      kind: "code",
      snippet: {
        filename: "echo.ts",
        language: "ts",
        code: `import { createApp } from "@usetoki/toki";

const app = createApp();

app.ws("/echo", (socket, req) => {
  socket.on("message", (data, isBinary) => {
    // echo binary unchanged, text with a prefix
    socket.send(isBinary ? data : \`echo: \${data.toString()}\`);
  });
});

app.listen(3000);`,
      },
    },
    {
      kind: "callout",
      tone: "warning",
      text: "The `Buffer` handed to `message`, `ping`, and `pong` is a view over native memory valid only for the duration of the call. Copy it (`Buffer.from(data)` or `data.toString()`) before you stash it in an array, a closure, or anything that outlives the listener.",
    },
    { kind: "heading", id: "subprotocols", text: "Subprotocols" },
    {
      kind: "paragraph",
      text: "The three-argument form takes a `WebSocketOptions` between the path and the handler. `protocols` lists the subprotocols this route supports; the server echoes the first one the client also offers, and `socket.protocol` holds the negotiated value (or `\"\"` when none was agreed).",
    },
    {
      kind: "code",
      snippet: {
        filename: "subprotocol.ts",
        language: "ts",
        code: `app.ws("/chat", { protocols: ["chat.v2", "chat.v1"] }, (socket, req) => {
  console.log(\`connected from \${req.ip} speaking \${socket.protocol}\`);
  if (socket.protocol === "chat.v1") {
    // serve the legacy framing for old clients
  }
});`,
      },
    },
    { kind: "heading", id: "the-socket", text: "The connection" },
    {
      kind: "table",
      headers: ["Member", "Description"],
      rows: [
        ["`socket.send(data)`", "Send a text (`string`) or binary (`Uint8Array`) message. Returns the write backlog in bytes — `0` once flushed, `-1` if the connection is closed."],
        ["`socket.ping(data?)`", "Send a ping; the peer answers with a pong. Payload capped at 125 bytes."],
        ["`socket.pong(data?)`", "Send an unsolicited pong, e.g. a one-way heartbeat. Payload capped at 125 bytes."],
        ["`socket.close(code?)`", "Send a close frame (default code `1000`) and tear the connection down."],
        ["`socket.protocol`", "The negotiated subprotocol, or `\"\"` when none was agreed."],
        ["`socket.data`", "A free-form `Record` for per-connection state — a user id, a room name, a sequence counter."],
        ["`socket.closed`", "`true` once the connection has closed."],
        ["`socket.on(event, fn)`", "Attach a listener. Returns `this`, so calls chain."],
      ],
    },
    { kind: "heading", id: "events", text: "Events" },
    {
      kind: "table",
      headers: ["Event", "Arguments", "Fires"],
      rows: [
        ["`message`", "`(data: Buffer, isBinary: boolean)`", "Once per complete message."],
        ["`close`", "`(code: number, reason: string)`", "Once, with the peer's close code and reason."],
        ["`ping`", "`(data: Buffer)`", "On an incoming ping — a pong is sent automatically."],
        ["`pong`", "`(data: Buffer)`", "On an incoming pong."],
        ["`drain`", "`()`", "When a backpressured socket's write queue empties."],
      ],
    },
    { kind: "heading", id: "json", text: "JSON messages" },
    {
      kind: "paragraph",
      text: "WebSocket frames are bytes; a JSON protocol is `JSON.stringify` on the way out and `JSON.parse` on the way in. Parse defensively. A peer can send anything, and a throw inside a listener that you do not catch will not close the socket for you.",
    },
    {
      kind: "code",
      snippet: {
        filename: "json.ts",
        language: "ts",
        code: `interface ClientMsg {
  type: "subscribe" | "publish";
  topic: string;
  body?: unknown;
}

app.ws("/bus", (socket) => {
  socket.data.topics = new Set<string>();

  socket.on("message", (data, isBinary) => {
    if (isBinary) return socket.close(1003); // this route is text-only
    let msg: ClientMsg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return socket.send(JSON.stringify({ error: "bad json" }));
    }
    if (msg.type === "subscribe") {
      (socket.data.topics as Set<string>).add(msg.topic);
      socket.send(JSON.stringify({ ok: true, topic: msg.topic }));
    }
  });
});`,
      },
    },
    { kind: "heading", id: "broadcast", text: "Broadcast and chat" },
    {
      kind: "paragraph",
      text: "There is no built-in room registry — keep your own `Set` of live sockets and iterate it. Add on `open` (inside the handler body), remove on `close`, and skip closed sockets when you fan out.",
    },
    {
      kind: "code",
      snippet: {
        filename: "chat.ts",
        language: "ts",
        code: `import { createApp, type TokiWebSocket } from "@usetoki/toki";

const app = createApp();
const room = new Set<TokiWebSocket>();

function broadcast(text: string, except?: TokiWebSocket) {
  for (const peer of room) {
    if (peer === except || peer.closed) continue;
    peer.send(text);
  }
}

app.ws("/chat", (socket, req) => {
  socket.data.name = req.query.get("name") ?? "anon";
  room.add(socket);
  broadcast(\`* \${socket.data.name} joined\`, socket);

  socket.on("message", (data) => {
    broadcast(\`\${socket.data.name}: \${data.toString()}\`);
  });

  socket.on("close", () => {
    room.delete(socket);
    broadcast(\`* \${socket.data.name} left\`);
  });
});

app.listen(3000);`,
      },
    },
    {
      kind: "callout",
      tone: "note",
      text: "toki runs one engine per process (one `listen` per process). A `Set` of sockets is therefore process-local — to fan out across multiple workers, publish through Redis or another bus and have each worker broadcast to its own set.",
    },
    { kind: "heading", id: "backpressure", text: "Backpressure" },
    {
      kind: "paragraph",
      text: "`send` returns the socket's write backlog in bytes. When a consumer reads slower than you write, that number climbs — the data is queued in native memory waiting to flush. Watch it on a fast producer (a tail of a busy log, a firehose of ticks) and pause when it grows, resuming on `drain`.",
    },
    {
      kind: "code",
      snippet: {
        filename: "backpressure.ts",
        language: "ts",
        code: `const HIGH_WATER = 1 << 20; // 1 MiB queued

app.ws("/firehose", (socket) => {
  let paused = false;
  socket.on("drain", () => {
    paused = false;
  });

  const timer = setInterval(() => {
    if (paused) return; // let the socket catch up
    const backlog = socket.send(nextChunk());
    if (backlog < 0) return clearInterval(timer); // gone
    if (backlog > HIGH_WATER) paused = true;
  }, 10);

  socket.on("close", () => clearInterval(timer));
});`,
      },
    },
    { kind: "heading", id: "heartbeat", text: "Ping/pong heartbeats" },
    {
      kind: "paragraph",
      text: "An incoming ping is answered with a pong automatically; you only see the `ping` event if you want it. To detect a half-open connection (a peer that vanished without a close frame), ping on a timer and treat a missing pong as dead.",
    },
    {
      kind: "code",
      snippet: {
        filename: "heartbeat.ts",
        language: "ts",
        code: `app.ws("/live", (socket) => {
  let alive = true;
  socket.on("pong", () => {
    alive = true;
  });

  const beat = setInterval(() => {
    if (!alive) return socket.close(1001); // missed the last pong — drop it
    alive = false;
    socket.ping();
  }, 30_000);

  socket.on("close", () => clearInterval(beat));
});`,
      },
    },
    { kind: "heading", id: "compression", text: "permessage-deflate" },
    {
      kind: "paragraph",
      text: "Set `wsCompression: true` in `listen` to offer `permessage-deflate` (RFC 7692). It is negotiated per connection and applied transparently: handlers send and receive plain data, compression happens underneath. `maxWsMessageBytes` (default 16 MiB) caps the largest accepted message; it also bounds the inflate output, so a compression bomb cannot exhaust memory.",
    },
    {
      kind: "code",
      snippet: {
        filename: "ws-listen.ts",
        language: "ts",
        code: `app.listen(3000, {
  wsCompression: true,
  maxWsMessageBytes: 4 * 1024 * 1024, // reject anything over 4 MiB
});`,
      },
    },
    { kind: "heading", id: "close-codes", text: "Close codes" },
    {
      kind: "paragraph",
      text: "Pass an RFC 6455 close code to `socket.close(code)`; the peer receives it in its `close` event. toki also closes on protocol faults:",
    },
    {
      kind: "table",
      headers: ["Code", "Meaning"],
      rows: [
        ["`1000`", "Normal closure (the default for `close()`)."],
        ["`1001`", "Going away — server shutting down, or your heartbeat gave up."],
        ["`1003`", "Unacceptable data — e.g. binary on a text-only route."],
        ["`1007`", "Invalid payload — a compressed text frame that inflated to bad UTF-8 (sent for you)."],
        ["`1009`", "Message too big — a malformed or oversized compressed payload (sent for you)."],
      ],
    },
    {
      kind: "callout",
      tone: "tip",
      text: "A plain `GET` to a ws path with no `Upgrade` header gets `426 Upgrade Required`, so a misconfigured client fails loudly instead of hanging. Browsers' `WebSocket` and `Bun.connect` send the upgrade for you.",
    },
  ],
};
