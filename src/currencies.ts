// What the shop can receive in, and how prices are counted.
//
// Values are the send21 API enums from https://send21.io/docs/currencies
// (llms-full.txt "What each network carries"). Only real pairs are listed:
// USDT on Solana and Ethereum only, nothing but USDC, EURC and ETH on Base.

export type Send21Currency = "Btc" | "Usdc" | "Usdt" | "Eurc" | "Sol" | "Eth";
export type Send21Network = "Mainnet" | "Solana" | "Ethereum" | "Base" | "Arbitrum" | "Polygon";
type AddressKind = "bitcoin" | "lightning" | "solana" | "evm";

export interface Coin {
  id: string;
  emoji: string;
  label: string;
  currency: Send21Currency;
  network: Send21Network;
  method?: "Lightning";
  kind: AddressKind;
}

export const COINS: readonly Coin[] = [
  { id: "btc", emoji: "🟠", label: "BTC · Bitcoin", currency: "Btc", network: "Mainnet", kind: "bitcoin" },
  { id: "btc-ln", emoji: "⚡", label: "BTC · Lightning", currency: "Btc", network: "Mainnet", method: "Lightning", kind: "lightning" },
  { id: "usdc-sol", emoji: "🔵", label: "USDC · Solana", currency: "Usdc", network: "Solana", kind: "solana" },
  { id: "usdc-eth", emoji: "🔵", label: "USDC · Ethereum", currency: "Usdc", network: "Ethereum", kind: "evm" },
  { id: "usdc-base", emoji: "🔵", label: "USDC · Base", currency: "Usdc", network: "Base", kind: "evm" },
  { id: "usdc-arb", emoji: "🔵", label: "USDC · Arbitrum", currency: "Usdc", network: "Arbitrum", kind: "evm" },
  { id: "usdc-pol", emoji: "🔵", label: "USDC · Polygon", currency: "Usdc", network: "Polygon", kind: "evm" },
  { id: "usdt-sol", emoji: "🟢", label: "USDT · Solana", currency: "Usdt", network: "Solana", kind: "solana" },
  { id: "usdt-eth", emoji: "🟢", label: "USDT · Ethereum", currency: "Usdt", network: "Ethereum", kind: "evm" },
  { id: "eurc-sol", emoji: "💶", label: "EURC · Solana", currency: "Eurc", network: "Solana", kind: "solana" },
  { id: "eurc-eth", emoji: "💶", label: "EURC · Ethereum", currency: "Eurc", network: "Ethereum", kind: "evm" },
  { id: "eurc-base", emoji: "💶", label: "EURC · Base", currency: "Eurc", network: "Base", kind: "evm" },
  { id: "sol", emoji: "🟣", label: "SOL · Solana", currency: "Sol", network: "Solana", kind: "solana" },
  { id: "eth-eth", emoji: "💎", label: "ETH · Ethereum", currency: "Eth", network: "Ethereum", kind: "evm" },
  { id: "eth-base", emoji: "💎", label: "ETH · Base", currency: "Eth", network: "Base", kind: "evm" },
  { id: "eth-arb", emoji: "💎", label: "ETH · Arbitrum", currency: "Eth", network: "Arbitrum", kind: "evm" },
];

export const coinById = (id: string): Coin | undefined => COINS.find((c) => c.id === id);

/** The coin a pay-link option or a webhook's sentCurrency/network belongs to. */
export function coinFor(currency: string, network: string, method?: string | null): Coin | undefined {
  const lc = (s: string | null | undefined) => String(s ?? "").toLowerCase();
  return COINS.find((c) => lc(c.currency) === lc(currency) && lc(c.network) === lc(network) && lc(c.method) === lc(method));
}

// Orders are priced in fiat: a send21 payment request is a fiat-priced pay link
// (POST /payment-requests takes fiatCurrency + fiatAmount). The payer picks one
// of the receiver's coins on the pay page and the rate locks for 15 minutes.
export const FIATS = ["EUR", "USD", "GBP", "SEK", "NOK", "DKK", "CHF", "PLN", "CAD", "AUD", "JPY", "BRL", "MXN", "INR"] as const;
export type Fiat = (typeof FIATS)[number];
const ZERO_DECIMAL = new Set<string>(["JPY"]);
export const fiatDecimals = (fiat: string): number => (ZERO_DECIMAL.has(fiat.toUpperCase()) ? 0 : 2);
export const isFiat = (s: string): s is Fiat => (FIATS as readonly string[]).includes(s);

/** Integer minor units (cents, or whole yen). Compare amounts with this, never with floats. */
export const toMinor = (amount: number, fiat: string): number => Math.round(Number(amount) * 10 ** fiatDecimals(fiat));

export type AmountCheck = { ok: true; amount: number } | { ok: false; error: string };

/** Strict fiat amount: positive, at most the currency's decimals, at most max. */
export function parseTotal(raw: unknown, fiat: string, max: number): AmountCheck {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim().replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: "🔢 total must be above 0" };
  const d = fiatDecimals(fiat);
  const minor = n * 10 ** d;
  if (Math.abs(minor - Math.round(minor)) > 1e-6) return { ok: false, error: `🔢 max ${d} decimals for ${fiat}` };
  if (n > max) return { ok: false, error: `🔢 max ${max} ${fiat}` };
  return { ok: true, amount: Math.round(minor) / 10 ** d };
}

const SYMBOL: Record<string, string> = { EUR: "€", USD: "$", GBP: "£" };

/** €12.30, $5.00, 120 SEK. */
export function formatFiat(amount: number, fiat: string): string {
  const d = fiatDecimals(fiat);
  const n = amount.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const sym = SYMBOL[fiat.toUpperCase()];
  return sym ? `${sym}${n}` : `${n} ${fiat}`;
}

// ---------- receiving addresses ----------

const PATTERNS: Record<AddressKind, RegExp> = {
  // bech32 / bech32m (lowercase) or legacy base58 P2PKH / P2SH
  bitcoin: /^(?:bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/,
  lightning: /^[a-z0-9._+-]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/,
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  evm: /^0x[0-9a-fA-F]{40}$/,
};

export type AddressCheck = { ok: true; address: string } | { ok: false; error: string };

/**
 * Shape check for a receiving address. send21 checks the address again when
 * the pay link is created (token contracts, mints and the zero address are refused).
 */
export function checkAddress(coin: Coin, raw: string): AddressCheck {
  const input = String(raw ?? "").trim();
  // People paste the wrong thing. Never store anything that looks like a secret.
  if (input.split(/\s+/).filter((w) => /^[a-z]+$/i.test(w)).length >= 12) {
    return { ok: false, error: "🚫 that looks like a seed phrase. Never share it. Only your address." };
  }
  if (/^(?:0x)?[0-9a-fA-F]{64}$/.test(input)) {
    return { ok: false, error: "🚫 that looks like a private key. Never share it. Only your address." };
  }
  let address = input;
  if (coin.kind === "bitcoin" && /^bc1/i.test(address)) address = address.toLowerCase();
  if (coin.kind === "lightning") address = address.toLowerCase();
  if (!PATTERNS[coin.kind].test(address)) return { ok: false, error: `❌ not a ${coin.label} address` };
  if (coin.kind === "evm" && /^0x0{40}$/.test(address)) return { ok: false, error: "❌ zero address" };
  return { ok: true, address };
}

/** Short form for chat: bc1qxy…0wlh */
export const shortAddress = (a: string): string => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
