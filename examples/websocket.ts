// A WebSocket echo endpoint with subprotocol negotiation and a live client.
// run: node examples/websocket.ts
import assert from "node:assert/strict";
import { createApp } from "../dist/index.js";

const PORT = 8090;

const app = createApp();

app.ws("/chat", { protocols: ["chat"] }, (socket, req) => {
  console.log(
    `client connected from ${req.ip || "local"} (protocol: ${socket.protocol || "none"})`,
  );

  socket.on("message", (data, isBinary) => {
    if (isBinary)
      socket.send(data); // echo binary unchanged
    else socket.send(`echo: ${data.toString()}`);
  });

  socket.on("close", (code, reason) => {
    console.log(`client closed (${code}${reason ? ` ${reason}` : ""})`);
  });
});

const handle = app.listen(PORT, { host: "127.0.0.1" });

async function main(): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/chat`, "chat");
  await new Promise<void>((resolve) => (ws.onopen = () => resolve()));
  assert.equal(ws.protocol, "chat");

  const reply = new Promise<string>((resolve) => {
    ws.addEventListener("message", (e) => resolve(e.data as string), { once: true });
  });
  ws.send("hello");
  assert.equal(await reply, "echo: hello");

  ws.close(1000);
  await new Promise<void>((resolve) => (ws.onclose = () => resolve()));
  handle.close();
  console.log("websocket example OK");
  process.exit(0);
}

main();
