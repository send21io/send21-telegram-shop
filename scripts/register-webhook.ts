// npm run webhook:register: create the send21 webhook endpoint for this app.
//   POST /api/v1/webhooks  { url, events }   (key scope webhooks:manage)
// The response holds the signing secret ONCE. Put it in .env as SEND21_WEBHOOK_SECRET.
// You can also create the webhook in the send21 web app instead.
import "dotenv/config";

export const EVENTS = [
  "draft.seen",
  "draft.confirmed",
  "draft.amount_mismatch",
  "draft.mismatch_accepted",
  "draft.mismatch_rejected",
  "draft.mismatch_unresolved",
  "draft.expired",
  "payment_request.expired",
];

const key = process.env.SEND21_API_KEY;
const publicUrl = process.env.PUBLIC_URL?.replace(/\/$/, "");
const base = (process.env.SEND21_API_BASE ?? "https://send21.io").replace(/\/$/, "");
if (!key) throw new Error("SEND21_API_KEY is required (scope webhooks:manage)");
if (!publicUrl?.startsWith("https://")) throw new Error("PUBLIC_URL must be your public https:// address");

const res = await fetch(`${base}/api/v1/webhooks`, {
  method: "POST",
  headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
  body: JSON.stringify({ url: `${publicUrl}/webhooks/send21`, events: EVENTS }),
});
const json = (await res.json().catch(() => null)) as { id?: string; secret?: string } | null;
if (!res.ok || !json?.secret) throw new Error(`send21 POST /webhooks: ${res.status}`);
console.log(`✅ webhook ${json.id} → ${publicUrl}/webhooks/send21`);
console.log("🔑 add this line to .env now (shown only once):");
console.log(`SEND21_WEBHOOK_SECRET=${json.secret}`);
