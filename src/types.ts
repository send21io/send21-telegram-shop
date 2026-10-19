/** One pay-link option: a coin the shop accepts and its own receiving address. */
export interface PayOption {
  currency: string;
  network: string;
  address: string;
  method?: string;
}

export interface Product {
  sku: string;
  name: string;
  emoji: string;
  /** Fiat price in the shop currency. */
  price: number;
  /** Optional https photo URL, sent with sendPhoto. */
  photo?: string;
  stock: number;
  digital: boolean;
}

export interface Catalog {
  shop: string;
  currency: string;
  products: Product[];
}

export interface OrderItem {
  sku: string;
  name: string;
  emoji: string;
  qty: number;
  price: number;
}

export type OrderStatus =
  | "open" // 💳 pay link sent
  | "seen" // 👀 payment on its way
  | "review" // ⚠️ a different amount arrived, the shop decides on send21
  | "accepted" // 👍 accepted, waiting for draft.confirmed
  | "paid" // ✅ final
  | "declined" // ↩️ different amount declined: stock back
  | "unresolved" // ⚠️ expired undecided, money arrived: stock held
  | "expired" // ⌛ stock back
  | "flagged" // 🚩 confirmed but does not match: stock held, never paid
  | "failed"; // the pay link could not be created: stock back

/** Statuses that keep their items off the shelf. */
export const HOLDS_STOCK: readonly OrderStatus[] = ["open", "seen", "review", "accepted", "paid", "unresolved", "flagged"];

export interface Order {
  /** Random, 10 × [a-z0-9]; orderId on send21 is tg-<id>. */
  id: string;
  /** Short number for people: "order #12". */
  number: number;
  orderId: string;
  chatId: number;
  buyer: string;
  items: OrderItem[];
  total: number;
  currency: string;
  note: string;
  options: PayOption[];
  status: OrderStatus;
  paymentRequestId: string | null;
  payUrl: string | null;
  expiresAt: string | null;
  paid?: { currency: string; network: string; amount: string | null; txId: string; differentAmount: boolean; late: boolean; at: string };
  problems?: string[];
  createdAt: string;
  updatedAt: string;
}

/** Per chat: the cart and a checkout waiting for its shipping note. */
export interface ChatState {
  cart: Record<string, number>;
  /** Set at ✅ checkout, used when the note arrives: a repeated note never creates a second order. */
  pending: { id: string; items: OrderItem[] } | null;
  catalogMessageId?: number;
}
