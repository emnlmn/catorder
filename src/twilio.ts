// Twilio WhatsApp Sandbox webhook (SPEC "Live WhatsApp"): signature, sender, media, storage. Replies are reply.ts, sent only by the operator.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db.ts";
import type { Channel } from "./types.ts";

export const UNKNOWN_SENDER = "unknown-sender";
export const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
const MAX_MEDIA = 10 * 1024 * 1024;
const PER_MINUTE = 30;

const AUDIO: Record<string, string> = { "audio/ogg": ".ogg", "audio/opus": ".ogg", "audio/amr": ".amr", "audio/mpeg": ".mp3" };
const IMAGE: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };

/** Fetches a media URL with the account's credentials. Injected so tests need no network. */
export type Download = (url: string, sid: string, token: string) => Promise<Buffer>;

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  publicUrl: string; // https origin Twilio posts to, no trailing slash
  phoneMap: Record<string, string>; // E.164 -> customer id
  inboxDir: string;
}

/** Twilio's scheme: the full URL, then every POST parameter as key+value sorted by key; HMAC-SHA1, base64. */
export function twilioSignature(url: string, params: Record<string, string>, token: string): string {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return createHmac("sha1", token).update(data).digest("base64");
}

export function validSignature(given: string | undefined, url: string, params: Record<string, string>, token: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given), b = Buffer.from(twilioSignature(url, params, token));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** "+15005550006=deli-mulino,+15005550007=bar-ponterosso" -> map. */
export function parsePhoneMap(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of s.split(",")) {
    const i = pair.indexOf("=");
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

/** All but the last 3 digits masked: +39 333 123 456 -> +*********456. */
export const maskNumber = (n: string): string => n.replace(/\d(?=\d{3})/g, "*");

/** Local time, ISO seconds with offset, e.g. 2026-10-16T08:12:00+02:00. */
export function isoOffset(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset(), a = Math.abs(off);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    + `${off < 0 ? "-" : "+"}${p(Math.floor(a / 60))}:${p(a % 60)}`;
}

export const downloadMedia: Download = async (url, sid, token) => {
  const auth = { authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64") };
  let res = await fetch(url, { headers: auth, redirect: "manual" });
  const to = res.headers.get("location");
  if (to && res.status >= 300 && res.status < 400) res = await fetch(to); // Twilio redirects to a signed storage URL that must not get the auth header
  if (!res.ok) throw new Error(`media download failed (${res.status})`);
  if (Number(res.headers.get("content-length") ?? 0) > MAX_MEDIA) throw new Error("media too large");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_MEDIA) throw new Error("media too large");
  return buf;
};

// ponytail: per-process memory of recent arrivals, upgrade to a shared store when there is more than one process.
const recent = new Map<string, number[]>();
export function rateLimited(from: string, now = Date.now()): boolean {
  const hits = (recent.get(from) ?? []).filter((t) => now - t < 60_000);
  hits.push(now);
  recent.set(from, hits);
  return hits.length > PER_MINUTE;
}

export function ensureUnknownSender(db: Db): void {
  db.prepare("INSERT OR IGNORE INTO customers VALUES (?,?,?,?,?)").run(UNKNOWN_SENDER, "Numero sconosciuto", "", "", "{}");
}

interface Stored { channel: Channel; text: string | null; media: string | null; blob: Buffer }

/** Downloads the first media item when it is a supported type; anything else becomes a text message. */
async function toStored(p: URLSearchParams, id: string, cfg: TwilioConfig, download: Download): Promise<Stored> {
  const body = p.get("Body") || null;
  const type = (p.get("MediaContentType0") ?? "").split(";")[0].trim().toLowerCase();
  const text = (t: string): Stored => ({ channel: "whatsapp", text: t, media: null, blob: Buffer.from(t) });
  if (!(Number(p.get("NumMedia")) > 0)) return text(body ?? "");
  const ext = AUDIO[type] ?? IMAGE[type];
  if (!ext) return text(body ?? `[allegato non supportato: ${type || "sconosciuto"}]`);
  let bytes: Buffer;
  // the signed webhook names the account that owns the media; a stale TWILIO_ACCOUNT_SID would otherwise get 401
  const sid = /^AC[0-9a-f]{32}$/.test(p.get("AccountSid") ?? "") ? p.get("AccountSid")! : cfg.accountSid;
  try { bytes = await download(p.get("MediaUrl0") ?? "", sid, cfg.authToken); }
  catch (e) { console.error("media download failed for", id, (e as Error).message); return text(body ?? "[allegato non scaricato]"); }
  if (bytes.length > MAX_MEDIA) return text(body ?? "[allegato troppo grande]");
  mkdirSync(cfg.inboxDir, { recursive: true });
  const media = id + ext;
  writeFileSync(join(cfg.inboxDir, media), bytes);
  return { channel: AUDIO[type] ? "voice" : "photo", text: body, media, blob: bytes };
}

/** Stores the message; -> its id, or null when that MessageSid is already stored. */
export async function storeWhatsApp(db: Db, p: URLSearchParams, cfg: TwilioConfig, download: Download): Promise<string | null> {
  const id = "wa-live-" + p.get("MessageSid");
  if (db.prepare("SELECT 1 FROM messages WHERE id=?").get(id)) return null;
  const number = (p.get("From") ?? "").replace(/^whatsapp:/, "");
  const customer = cfg.phoneMap[number] ?? UNKNOWN_SENDER;
  const m = await toStored(p, id, cfg, download);
  db.prepare("INSERT OR IGNORE INTO messages VALUES (?,?,?,?,?,?,?,?)").run(id, customer, m.channel, isoOffset(),
    p.get("ProfileName") || maskNumber(number), m.text, m.media, createHash("sha256").update(m.blob).digest("hex"));
  if (number) db.prepare("INSERT OR IGNORE INTO senders VALUES (?,?)").run(id, number);
  return id;
}
