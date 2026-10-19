import { describe, expect, it } from "vitest";
import { createSend21Client, friendlyError, Send21Error } from "../src/send21.js";

const body = { fiatCurrency: "EUR", fiatAmount: 53, orderId: "tg-abcdefghij", memo: "🛍️ Order #1", options: [], expiryHours: 2, reuseOpenForOrder: true };

describe("send21 client", () => {
  it("POSTs /api/v1/payment-requests with the key and the Idempotency-Key", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ id: "pr-1", payPath: "/pay/t1", status: "Open", expiresAt: "2026-10-19T12:00:00.000Z" }), { status: 201 });
    }) as unknown as typeof fetch;
    const c = createSend21Client({ apiKey: "s21_test", fetchImpl });
    const r = await c.createPaymentRequest(body, "tg-abcdefghij");
    expect(seen!.url).toBe("https://send21.io/api/v1/payment-requests");
    const h = seen!.init.headers as Record<string, string>;
    expect(h.authorization).toBe("Bearer s21_test");
    expect(h["idempotency-key"]).toBe("tg-abcdefghij");
    expect(JSON.parse(String(seen!.init.body))).toEqual(body);
    expect(c.payUrl(r.payPath)).toBe("https://send21.io/pay/t1");
    expect(() => c.payUrl("https://evil.com/x")).toThrow();
  });

  it("turns errors into short buyer-safe text and never echoes the key", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: "fees" }), { status: 402 })) as unknown as typeof fetch;
    const err = await createSend21Client({ apiKey: "s21_secret_value", fetchImpl }).createPaymentRequest(body, "k").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Send21Error);
    expect(String((err as Error).message)).not.toContain("s21_secret_value");
    expect(friendlyError(err)).not.toMatch(/s21_/);
  });
});
