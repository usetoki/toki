export function encode(input: Buffer): string {
  return input.toString("base64url");
}

export function decode(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

export function encodeJson(value: unknown): string {
  return encode(Buffer.from(JSON.stringify(value), "utf8"));
}

export function decodeJson<T>(input: string): T {
  return JSON.parse(decode(input).toString("utf8")) as T;
}
