import type { DocPage } from "../../types";

export const websocketsPage: DocPage = {
  slug: "websockets",
  title: "WebSockets",
  description: "Full RFC 6455 WebSockets with native framing, events, and permessage-deflate.",
  blocks: [
    {
      kind: "paragraph",
      text: "`app.ws(path, handler)` registers a WebSocket endpoint. The handshake, framing, masking, fragmentation, ping/pong, and close handshake all run in native code, so your handler only ever sees complete messages.",
    },
    {
      kind: "code",
      snippet: {
        filename: "chat.ts",
        language: "ts",
        code: `app.ws("/chat", { protocols: ["chat"] }, (socket, req) => {
  console.log(\`connected from \${req.ip} as \${socket.protocol}\`);

  socket.on("message", (data, isBinary) => {
    socket.send(isBinary ? data : "echo: " + data.toString());
  });
  socket.on("close", (code, reason) => console.log("closed", code, reason));
});`,
      },
    },
    { kind: "heading", id: "sending", text: "Sending" },
    {
      kind: "table",
      headers: ["Method", "Description"],
      rows: [
        ["`socket.send(data)`", "Send a text (`string`) or binary (`Uint8Array`) message; returns the write backlog in bytes."],
        ["`socket.ping(data?)`", "Send a ping; the peer answers with a pong."],
        ["`socket.pong(data?)`", "Send an unsolicited pong (heartbeat)."],
        ["`socket.close(code?)`", "Send a close frame and tear the connection down."],
      ],
    },
    { kind: "heading", id: "events", text: "Events" },
    {
      kind: "table",
      headers: ["Event", "Arguments"],
      rows: [
        ["`message`", "`(data: Buffer, isBinary: boolean)`"],
        ["`close`", "`(code: number, reason: string)`"],
        ["`ping` / `pong`", "`(data: Buffer)`"],
        ["`drain`", "`()` — fires when a backpressured socket's write queue empties"],
      ],
    },
    {
      kind: "callout",
      tone: "warning",
      text: "The `Buffer` passed to `message` / `ping` / `pong` is a view over native memory valid only during the call — copy it (`Buffer.from(data)` or `data.toString()`) to keep it.",
    },
    { kind: "heading", id: "state", text: "State & subprotocols" },
    {
      kind: "list",
      items: [
        "`socket.data` is a free-form per-connection bag for your application.",
        "`socket.protocol` is the negotiated subprotocol (the server echoes the first the client also offers).",
        "A plain `GET` to a ws path (no `Upgrade` header) returns `426 Upgrade Required`.",
      ],
    },
    { kind: "heading", id: "compression", text: "Compression" },
    {
      kind: "paragraph",
      text: "Set `wsCompression: true` in `listen` to offer `permessage-deflate` (RFC 7692). It is negotiated per connection and applied transparently — handlers send and receive plain data. The largest accepted message is capped by `maxWsMessageBytes` (default 16 MiB).",
    },
    {
      kind: "code",
      snippet: {
        filename: "ws-listen.ts",
        language: "ts",
        code: `app.listen(3000, { wsCompression: true, maxWsMessageBytes: 4 * 1024 * 1024 });`,
      },
    },
  ],
};
