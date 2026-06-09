import { JwtError } from "./errors.ts";
import type { JwtPayload } from "./types.ts";

export interface ClaimChecks {
  issuer?: string | string[] | undefined;
  audience?: string | string[] | undefined;
  subject?: string | undefined;
  clockTolerance: number;
  now: number;
}

/** Validate the time + identity claims, throwing JwtError on any mismatch. */
export function validateClaims(payload: JwtPayload, checks: ClaimChecks): void {
  // a non-finite tolerance would push exp/nbf to ±Infinity and disable the check entirely
  const tolerance = Number.isFinite(checks.clockTolerance) ? checks.clockTolerance : 0;
  if (typeof payload.exp === "number" && checks.now >= payload.exp + tolerance) {
    throw new JwtError("token expired");
  }
  if (typeof payload.nbf === "number" && checks.now + tolerance < payload.nbf) {
    throw new JwtError("token not yet valid");
  }
  if (checks.issuer !== undefined && !includes(checks.issuer, payload.iss)) {
    throw new JwtError("issuer mismatch");
  }
  if (checks.subject !== undefined && payload.sub !== checks.subject) {
    throw new JwtError("subject mismatch");
  }
  if (checks.audience !== undefined && !audienceMatches(checks.audience, payload.aud)) {
    throw new JwtError("audience mismatch");
  }
}

function includes(expected: string | string[], value: unknown): boolean {
  const list = Array.isArray(expected) ? expected : [expected];
  return typeof value === "string" && list.includes(value);
}

function audienceMatches(expected: string | string[], aud: unknown): boolean {
  const have = Array.isArray(aud) ? aud : typeof aud === "string" ? [aud] : [];
  const want = Array.isArray(expected) ? expected : [expected];
  return want.some((w) => have.includes(w));
}
