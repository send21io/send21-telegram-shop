import { createHmac, timingSafeEqual } from "node:crypto";

// send21 webhook signature, as documented at https://send21.io/docs/webhooks:
//
//   X-Send21-Signature-V2: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<delivery id>.<raw body>">
//
// keyed with the endpoint's signing secret. The time and the X-Send21-Delivery
// id are signed too, so a copied delivery cannot be replayed later. We refuse
// anything more than 300 seconds old (or from the future). The legacy
// X-Send21-Signature header (body only, no timestamp) is NOT accepted.
// Same check as send21-examples/examples/webhook-receiver.
export const TOLERANCE_SECONDS = 300;

const hmacHex = (secret: string, data: Buffer): string => createHmac("sha256", secret).update(data).digest("hex");

/** Build an X-Send21-Signature-V2 value. Used by tests and the mock pay page. */
export function signV2(rawBody: Buffer | string, deliveryId: string, timestamp: number | string, secret: string): string {
  const signed = Buffer.concat([Buffer.from(`${timestamp}.${deliveryId}.`), Buffer.from(rawBody)]);
  return `t=${timestamp},v1=${hmacHex(secret, signed)}`;
}

export interface VerifyOptions {
  /** Current time in Unix seconds (tests). */
  now?: number;
  /** At most 300. A larger value is clamped to 300. */
  toleranceSeconds?: number;
}

/**
 * Constant-time check of X-Send21-Signature-V2 including the timestamp window.
 * Never throws; a missing or malformed header returns false.
 */
export function verifySignatureV2(
  rawBody: Buffer | string,
  header: unknown,
  deliveryId: unknown,
  secret: string,
  { now = Date.now() / 1000, toleranceSeconds = TOLERANCE_SECONDS }: VerifyOptions = {},
): boolean {
  if (!secret || typeof header !== "string" || typeof deliveryId !== "string" || !deliveryId || deliveryId.length > 200) return false;
  const t = /(?:^|,)\s*t=(\d{1,12})(?:,|$)/.exec(header)?.[1];
  const v1 = /(?:^|,)\s*v1=([0-9a-f]{64})(?:,|$)/.exec(header)?.[1];
  if (!t || !v1) return false;
  const window = Math.min(toleranceSeconds, TOLERANCE_SECONDS);
  if (!(Math.abs(now - Number(t)) <= window)) return false;
  const expected = Buffer.from(signV2(rawBody, deliveryId, t, secret).split(",v1=")[1] ?? "", "hex");
  const given = Buffer.from(v1, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
