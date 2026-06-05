import net from "node:net";

export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ListenHandle only exposes close(), so raw-socket tests pick a free port up front.
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      probe.close(() => resolve(port));
    });
  });
}
