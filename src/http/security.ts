import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySlackRequest(input: {
  signingSecret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: string;
  nowSeconds?: number;
}): boolean {
  if (!input.timestamp || !input.signature || !/^v0=[a-f0-9]{64}$/.test(input.signature)) return false;
  const timestamp = Number(input.timestamp);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > 300) return false;
  const expected = `v0=${createHmac("sha256", input.signingSecret).update(`v0:${input.timestamp}:${input.rawBody}`).digest("hex")}`;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(input.signature));
}

export function bearerAuthorized(header: string | undefined, expected: string | undefined): boolean {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice(7));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
