import { randomBytes, randomUUID } from "node:crypto";
import type { PayOption } from "./types.js";

// Server-side send21 REST client, only what the app needs:
//   POST /api/v1/payment-requests   create a pay link (Idempotency-Key header)
//   POST /api/v1/webhooks           register the webhook (scripts/register-webhook.ts)
// Reference: https://send21.io/docs/quickstart, https://send21.io/openapi.json
// The key is a scoped key (drafts:write). No send21 key can move funds.

export interface CreatePaymentRequest {
  fiatCurrency: string;
  fiatAmount: number;
  orderId: string;
  memo: string;
  options: PayOption[];
  expiryHours: number;
  declineNote?: string;
  shortfallPolicy?: { absorbUpToPercent: number; absorbedBy: "receiver" };
  /** Return the open link for the same orderId instead of a second one. */
  reuseOpenForOrder?: boolean;
}

/** The fields of PaymentRequestResponse the app reads. */
export interface PaymentRequestResponse {
  id: string;
  shareToken?: string | null;
  payPath: string;
  orderId: string | null;
  fiatCurrency: string;
  fiatAmount: number;
  status: "Open" | "Completed" | "Cancelled" | "Expired";
  expiresAt: string;
  options?: PayOption[];
}

export interface Send21Client {
  mode: "live" | "mock";
  /** Absolute pay link for a payPath. */
  payUrl(payPath: string): string;
  createPaymentRequest(body: CreatePaymentRequest, idempotencyKey: string): Promise<PaymentRequestResponse>;
}

export class Send21Error extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

/**
 * New send21 accounts only accept receiving addresses the owner approved in the
 * app (passkey or authenticator code). Any other address: 422 address_not_approved,
 * nothing is created. https://send21.io/docs/mcp
 */
function errorCode(json: unknown): string | undefined {
  return (JSON.stringify(json) ?? "").includes("address_not_approved") ? "address_not_approved" : undefined;
}

/** Short, user-safe text for a failed create call. */
export function friendlyError(err: unknown): string {
  const status = err instanceof Send21Error ? err.status : 0;
  if (status === 402) return "🧾 the shop's send21 account has fees to settle first.";
  if (status === 409) return "🔁 this order already has a different pay link. Check out again.";
  if (status === 429) return "🐢 too many requests. Try again in a minute.";
  if (err instanceof Send21Error && err.code === "address_not_approved") return "🔐 the shop hasn't approved this receiving address in send21 yet, so no pay link was made.";
  if (status === 400 || status === 422) return "❌ send21 refused it (check the shop addresses).";
  return "😵 send21 didn't answer. Try again.";
}

export function createSend21Client({ apiBase = "https://send21.io", apiKey, fetchImpl = fetch }: { apiBase?: string; apiKey: string; fetchImpl?: typeof fetch }): Send21Client {
  const base = apiBase.replace(/\/$/, "");
  return {
    mode: "live",
    payUrl: (payPath) => {
      if (!/^\/[A-Za-z0-9/_\-.~]+$/.test(payPath)) throw new Send21Error("unexpected payPath", 502);
      return base + payPath;
    },
    async createPaymentRequest(body, idempotencyKey) {
      const res = await fetchImpl(`${base}/api/v1/payment-requests`, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      const json = (await res.json().catch(() => null)) as PaymentRequestResponse | null;
      if (!res.ok || !json) {
        // Never log the key or the request headers; the body is safe to log.
        const code = errorCode(json);
        const hint = code ? " (approve this receiving address in send21: sign in, approve it with a passkey or authenticator code, then retry)" : "";
        throw new Send21Error(`send21 POST /payment-requests: ${res.status} ${JSON.stringify(json)?.slice(0, 300)}${hint}`, res.status, code);
      }
      if (typeof json.id !== "string" || typeof json.payPath !== "string") throw new Send21Error("send21: response without id/payPath", 502);
      return json;
    },
  };
}

/**
 * Mock mode (no SEND21_API_KEY): the same call answered locally with the
 * documented response fields. Nothing is sent to send21. Pay links point at
 * the app's own /mock/pay/<token> page, where you can simulate a payment.
 */
export function createMockClient(localBase: string): Send21Client & { requests: Map<string, { body: CreatePaymentRequest; response: PaymentRequestResponse }> } {
  const byKey = new Map<string, { body: CreatePaymentRequest; response: PaymentRequestResponse }>();
  const requests = new Map<string, { body: CreatePaymentRequest; response: PaymentRequestResponse }>();
  return {
    mode: "mock",
    requests,
    payUrl: (payPath) => localBase.replace(/\/$/, "") + payPath,
    async createPaymentRequest(body, idempotencyKey) {
      const prior = byKey.get(idempotencyKey);
      if (prior) {
        if (JSON.stringify(prior.body) !== JSON.stringify(body)) throw new Send21Error("mock: Idempotency-Key reused with another request", 422);
        return prior.response;
      }
      const token = randomBytes(12).toString("base64url");
      const response: PaymentRequestResponse = {
        id: randomUUID(),
        shareToken: token,
        payPath: `/mock/pay/${token}`,
        orderId: body.orderId,
        fiatCurrency: body.fiatCurrency,
        fiatAmount: body.fiatAmount,
        status: "Open",
        expiresAt: new Date(Date.now() + body.expiryHours * 3600_000).toISOString(),
        options: body.options.map((o) => ({ ...o })),
      };
      const entry = { body, response };
      byKey.set(idempotencyKey, entry);
      requests.set(token, entry);
      return response;
    },
  };
}
