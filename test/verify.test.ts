import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signV2, TOLERANCE_SECONDS, verifySignatureV2 } from "../src/verify.js";
import { SECRET } from "./helpers.js";

const body = Buffer.from('{"event":"draft.confirmed","data":{"orderId":"tip-1"}}');
const id = "d-0001";
const now = 1_800_000_000;

describe("X-Send21-Signature-V2", () => {
  it("matches the documented scheme: HMAC-SHA256 of <t>.<delivery id>.<raw body>", () => {
    const expected = createHmac("sha256", SECRET).update(`${now}.${id}.${body.toString()}`).digest("hex");
    expect(signV2(body, id, now, SECRET)).toBe(`t=${now},v1=${expected}`);
  });

  it("accepts a valid signature", () => {
    expect(verifySignatureV2(body, signV2(body, id, now, SECRET), id, SECRET, { now })).toBe(true);
  });

  it("refuses a wrong secret, a changed body or another delivery id", () => {
    const h = signV2(body, id, now, SECRET);
    expect(verifySignatureV2(body, h, id, "other", { now })).toBe(false);
    expect(verifySignatureV2(Buffer.from(body.toString().replace("tip-1", "tip-2")), h, id, SECRET, { now })).toBe(false);
    expect(verifySignatureV2(body, h, "d-0002", SECRET, { now })).toBe(false);
  });

  it("uses a window of 300 s, both ways", () => {
    expect(TOLERANCE_SECONDS).toBe(300);
    const at = (t: number) => verifySignatureV2(body, signV2(body, id, t, SECRET), id, SECRET, { now });
    expect(at(now - 300)).toBe(true);
    expect(at(now - 301)).toBe(false);
    expect(at(now + 300)).toBe(true);
    expect(at(now + 301)).toBe(false);
  });

  it("never widens the window beyond 300 s", () => {
    const h = signV2(body, id, now - 3600, SECRET);
    expect(verifySignatureV2(body, h, id, SECRET, { now, toleranceSeconds: 86_400 })).toBe(false);
  });

  it("refuses missing, malformed and legacy headers without throwing", () => {
    const legacy = "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
    for (const h of [undefined, "", "garbage", legacy, `t=${now}`, `v1=${"a".repeat(64)}`, `t=${now},v1=${"A".repeat(64)}`, `t=${now},v1=${"a".repeat(63)}`]) {
      expect(verifySignatureV2(body, h, id, SECRET, { now })).toBe(false);
    }
  });

  it("refuses a missing delivery id or secret", () => {
    const h = signV2(body, id, now, SECRET);
    expect(verifySignatureV2(body, h, undefined, SECRET, { now })).toBe(false);
    expect(verifySignatureV2(body, h, "", SECRET, { now })).toBe(false);
    expect(verifySignatureV2(body, h, id, "", { now })).toBe(false);
  });

  it("checks raw bytes, not re-serialised JSON", () => {
    const pretty = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 2));
    expect(verifySignatureV2(pretty, signV2(body, id, now, SECRET), id, SECRET, { now })).toBe(false);
  });
});
