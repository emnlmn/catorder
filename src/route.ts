// Decides whether a new message adds to the open draft, starts a new order, or is not an order.
import type { Services } from "./read.ts";

export interface OpenDraft { orderId: string; lastAt: string; texts: string[]; lines: { name: string; qty: number | null }[] }
export interface RouteDecision { action: "attach" | "new" | "none"; quote: string | null; reason: string; by: "model" | "rule" }

const CONT = /\b(anche|aggiung\w*|togli\w*|anzi|invece|pure|in più|e poi|ancora)\b/i;
const NEW = /\b(altro|nuovo|un secondo)\s+ordine\b/i;
const NOT_ORDER = /\?\s*$|^\s*(grazie|ok|perfetto)\b/i;

const SYSTEM = `You route a customer's new WhatsApp message (Italian, informal) for a cat-food shop.
Given the customer's open draft order (messages, lines, minutes since its last message) and the NEW message, answer only JSON:
{"action":"attach|new|none","quote":"exact words from the NEW message that justify it, or null","reason":"<12 words"}
attach = continues or changes the open order ("e anche i tovaglioli", "togli il prosciutto", "anzi 6").
new = a separate order ("altro ordine", "nuovo ordine", "per la settimana prossima invece").
none = no order content ("a che ora passate?", "grazie").
With no open draft, attach is impossible.`;

const minutesSince = (open: OpenDraft, at: string) => (Date.parse(at) - Date.parse(open.lastAt)) / 60000;

export function ruleRoute(text: string, receivedAt: string, open: OpenDraft | null): RouteDecision {
  const n = NEW.exec(text);
  if (n) return { action: "new", quote: n[0], reason: "asks for another order", by: "rule" };
  if (!open) {
    if (!/\d/.test(text) && NOT_ORDER.test(text.trim())) return { action: "none", quote: null, reason: "a question, no products", by: "rule" };
    return { action: "new", quote: null, reason: "no open order", by: "rule" };
  }
  if (minutesSince(open, receivedAt) <= 120) return { action: "attach", quote: CONT.exec(text)?.[0] ?? null, reason: "continues the open order", by: "rule" };
  return { action: "new", quote: null, reason: "open order is old", by: "rule" };
}

export async function routeMessage(svc: Services, text: string, receivedAt: string, open: OpenDraft | null): Promise<RouteDecision> {
  if (svc.mock) return ruleRoute(text, receivedAt, open);
  try {
    const mins = open ? Math.round(minutesSince(open, receivedAt)) : null;
    const ctx = open
      ? `Open draft (last message ${mins} minutes ago):\n${open.texts.map((t) => `- ${t}`).join("\n")}\nLines: ${open.lines.map((l) => `${l.qty ?? "?"} x ${l.name}`).join("; ") || "none"}`
      : "No open draft.";
    const [raw] = await svc.chat.generate([{ role: "system", content: SYSTEM }, { role: "user", content: `${ctx}\n\nNEW message: ${text}` }]);
    const j = JSON.parse(/\{[\s\S]*\}/.exec(raw)?.[0] ?? "");
    if (!["attach", "new", "none"].includes(j.action)) throw new Error("bad action");
    let action: RouteDecision["action"] = j.action;
    let quote: string | null = typeof j.quote === "string" && j.quote && text.toLowerCase().includes(j.quote.toLowerCase()) ? j.quote : null;
    let reason = String(j.reason ?? "").slice(0, 120), by: RouteDecision["by"] = "model";
    if (action === "attach" && !open) action = "new";
    else if (action === "attach" && open) {
      const m = minutesSince(open, receivedAt);
      if ((!quote && m > 120) || (m > 720 && !(quote && CONT.test(quote)))) { action = "new"; reason = "too long since the open order"; by = "rule"; }
    }
    return { action, quote, reason, by };
  } catch {
    return ruleRoute(text, receivedAt, open);
  }
}
