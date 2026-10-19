import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadCatalog, sumItems } from "../src/catalog.js";

const sample = () => JSON.parse(readFileSync("products.example.json", "utf8"));
const withProduct = (p: Record<string, unknown>) => ({ shop: "Shop", currency: "EUR", products: [{ sku: "x", name: "X", emoji: "🌈", price: 1, stock: 1, ...p }] });

describe("products.json", () => {
  it("loads the sample catalog", () => {
    const c = loadCatalog(sample());
    expect(c.currency).toBe("EUR");
    expect(c.products.map((p) => p.sku)).toEqual(["sticker-pack", "a3-print", "hoodie", "wallpapers"]);
    expect(c.products.find((p) => p.sku === "wallpapers")?.digital).toBe(true);
  });

  it.each([
    [{ sku: "Bad SKU" }, /sku/],
    [{ name: "buy at evil.com" }, /name/],
    [{ emoji: "no" }, /emoji/],
    [{ price: -1 }, /price/],
    [{ price: "abc" }, /price/],
    [{ stock: 1.5 }, /stock/],
    [{ stock: -1 }, /stock/],
    [{ photo: "http://img.example/x.png" }, /https/],
    [{ photo: "javascript:alert(1)" }, /https/],
  ])("refuses %j", (p, err) => {
    expect(() => loadCatalog(withProduct(p))).toThrow(err);
  });

  it("refuses an unsupported currency, a duplicate sku and an empty list", () => {
    expect(() => loadCatalog({ ...withProduct({}), currency: "XYZ" })).toThrow(/currency/);
    expect(() => loadCatalog({ shop: "S", currency: "EUR", products: [withProduct({}).products[0], withProduct({}).products[0]] })).toThrow(/twice/);
    expect(() => loadCatalog({ shop: "S", currency: "EUR", products: [] })).toThrow(/at least one/);
  });

  it("keeps an https photo", () => {
    expect(loadCatalog(withProduct({ photo: "https://img.example/hoodie.jpg" })).products[0]?.photo).toBe("https://img.example/hoodie.jpg");
  });

  it("adds money in minor units", () => {
    expect(sumItems([{ price: 4.1, qty: 3 }, { price: 0.1, qty: 2 }], "EUR")).toBe(12.5);
    expect(sumItems([{ price: 500, qty: 3 }], "JPY")).toBe(1500);
  });
});
