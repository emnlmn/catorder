import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePhoneMap } from "./twilio.ts";
import type { Config } from "./types.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, ".."); // the repo root, where data/ and .env live

/** Tiny .env loader: KEY=VALUE, `#` comments, quotes stripped; real env wins. */
export function loadEnv(path = join(ROOT, ".env")): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.split(" #")[0].trim();
    const i = line.indexOf("=");
    if (!line || line.startsWith("#") || i < 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (!(k in process.env)) process.env[k] = v;
  }
}

const env = (name: string, def = ""): string => process.env[name] || def;

export function loadConfig(): Config {
  loadEnv();
  const baseUrl = env("MODEL_BASE_URL");
  const dataDir = env("CATORDER_DATA_DIR", join(ROOT, "data"));
  return {
    modelBaseUrl: baseUrl,
    modelApiKey: env("MODEL_API_KEY"),
    modelName: env("MODEL_NAME"),
    modelVision: env("MODEL_VISION", "1") !== "0",
    modelReasoningEffort: env("MODEL_REASONING_EFFORT"),
    modelTimeoutS: Number(env("MODEL_TIMEOUT_S", "120")),
    modelHardware: env("MODEL_HARDWARE"),
    transcribeBaseUrl: env("TRANSCRIBE_BASE_URL"),
    transcribeApiKey: env("TRANSCRIBE_API_KEY"),
    transcribeModel: env("TRANSCRIBE_MODEL"),
    db: env("CATORDER_DB", "./catorder.db"),
    today: env("CATORDER_TODAY"),
    offline: env("CATORDER_OFFLINE") === "1",
    refresh: env("CATORDER_REFRESH") === "1",
    mock: env("CATORDER_MOCK") === "1" || !baseUrl,
    port: Number(env("PORT", "7860")),
    dataDir,
    inboxDir: env("CATORDER_INBOX_DIR", join(dataDir, "inbox")),
    twilioAccountSid: env("TWILIO_ACCOUNT_SID"),
    twilioAuthToken: env("TWILIO_AUTH_TOKEN"),
    publicUrl: env("PUBLIC_URL").replace(/\/+$/, ""),
    whatsappFrom: env("TWILIO_WHATSAPP_FROM", "+14155238886"), // the sandbox number replies go out from
    whatsappPhoneMap: parsePhoneMap(env("WHATSAPP_PHONE_MAP")),
    predictBaseUrl: env("PREDICT_BASE_URL"),
    predictToken: env("PREDICT_TOKEN"),
  };
}
