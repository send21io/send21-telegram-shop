import { describe, expect, it } from "vitest";
import { createSend21Client, friendlyError, Send21Error } from "../src/send21.js";

// New send21 accounts only accept receiving addresses the owner approved.
// Anything else is refused with 422 address_not_approved and nothing is created.
const body = { fiatCurrency: "EUR", fiatAmount: 5, orderId: "order-1", memo: "test", options: [], expiryHours: 1 };

const refuse = (status: number, json: unknown) =>
  (async () => new Response(JSON.stringify(json), { status })) as unknown as typeof fetch;

describe("send21 address approval", () => {
  for (const json of [{ error: "address_not_approved" }, { title: "address_not_approved", status: 422 }, { code: "address_not_approved" }]) {
    it(`explains 422 address_not_approved (${Object.keys(json)[0]})`, async () => {
      const err = await createSend21Client({ apiKey: "s21_secret_value", fetchImpl: refuse(422, json) })
        .createPaymentRequest(body as never, "k")
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Send21Error);
      expect((err as Send21Error).code).toBe("address_not_approved");
      expect((err as Error).message).toMatch(/approve/);
      expect((err as Error).message).not.toContain("s21_secret_value");
      expect(friendlyError(err)).toMatch(/approved/);
    });
  }

  it("keeps the generic text for other 422s", async () => {
    const err = await createSend21Client({ apiKey: "s21_x", fetchImpl: refuse(422, { error: "invalid_option" }) })
      .createPaymentRequest(body as never, "k")
      .catch((e: unknown) => e);
    expect((err as Send21Error).code).toBeUndefined();
    expect(friendlyError(err)).toMatch(/refused/);
  });
});
