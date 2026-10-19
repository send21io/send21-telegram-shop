// Cleaning user text: shipping notes and names.

// C0/C1 controls, zero-width characters and bidi overrides (used for spoofing).
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200c\u200e-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const URL_LIKE = /(?:https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|io|gg|xyz|net|org|app|link|me)\b)/i;

/** One line of plain text, invisible characters removed, max `max` characters. Null when empty or not allowed. */
export function cleanText(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  if (!s || URL_LIKE.test(s) || /[<>]/.test(s)) return null;
  return [...s].length > max ? null : s;
}

// One emoji (with skin tone, ZWJ sequences and flags). U+200D is kept above for ZWJ.
const EMOJI = /^(?:\p{Regional_Indicator}{2}|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*)$/u;
export const isEmoji = (s: unknown): s is string => typeof s === "string" && s.length <= 16 && EMOJI.test(s);
