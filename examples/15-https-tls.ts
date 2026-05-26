// HTTPS by passing PEM cert + key read from disk (tlsCert + tlsKey).
// Run: npx tsx examples/15-https-tls.ts   then   curl -k https://127.0.0.1:3015/
// Generate certs first: openssl req -x509 -newkey rsa:2048 -nodes -keyout examples/key.pem -out examples/cert.pem -days 365 -subj '/CN=localhost'

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Toki, reply } from "../ts";

const PORT = 3015;
const CERT_PATH = join(__dirname, "cert.pem");
const KEY_PATH = join(__dirname, "key.pem");

const app = new Toki();

app.get("/", () => reply.text("Hello over HTTPS"));
app.get("/whoami", (req) => reply.json({ secure: true, requestId: req.id }));

async function main(): Promise<void> {
  let tlsCert: string;
  let tlsKey: string;
  try {
    [tlsCert, tlsKey] = await Promise.all([
      readFile(CERT_PATH, "utf8"),
      readFile(KEY_PATH, "utf8"),
    ]);
  } catch {
    console.error(
      "Missing examples/cert.pem or examples/key.pem. Generate them with:\n" +
        "  openssl req -x509 -newkey rsa:2048 -nodes -keyout examples/key.pem -out examples/cert.pem -days 365 -subj '/CN=localhost'",
    );
    process.exit(1);
  }

  const server = await app.listen({ port: PORT, tlsCert, tlsKey });
  console.log(`READY https://${server.host}:${server.port}`);
  process.on("SIGINT", () => {
    server.close();
    process.exit(0);
  });
}

void main();
