// OpenAI-compatible chat and transcription clients (fetch, no SDK), plus the mock and fakes.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./config.ts";
import { ModelError, sha, type Usage } from "./cache.ts";
import type { ChatMessage } from "./prompt.ts";

export { ModelError, sha };
export type { Usage };
const ZERO: Usage = { prompt_tokens: 0, completion_tokens: 0 };

async function post(url: string, timeoutS: number, init: RequestInit): Promise<any> {
  let r: Response;
  try {
    r = await fetch(url, { ...init, method: "POST", signal: AbortSignal.timeout(timeoutS * 1000) });
  } catch (e) {
    throw new ModelError(0, String(e));
  }
  const text = await r.text();
  if (r.status >= 300) throw new ModelError(r.status, text);
  try { return JSON.parse(text); } catch { throw new ModelError(r.status, text); }
}

export interface ChatLike { name: string; generate(messages: ChatMessage[]): Promise<[string, Usage]> }
export interface TranscriberLike { name: string; transcribe(audio: Uint8Array, filename: string): Promise<[string, Usage]> }

export class ChatModel implements ChatLike {
  baseUrl: string;
  constructor(baseUrl: string, private apiKey: string, public name: string, private timeoutS = 120, private reasoningEffort = "") {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async generate(messages: ChatMessage[]): Promise<[string, Usage]> {
    const body: Record<string, unknown> = { model: this.name, messages, temperature: 0, max_tokens: 2048 };
    if (this.reasoningEffort) body.reasoning_effort = this.reasoningEffort;
    const call = () => post(`${this.baseUrl}/chat/completions`, this.timeoutS, {
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    // Token Factory allows 20 requests a minute: a 429 waits out the window, up to 5 times
    let data;
    for (let i = 0; ; i++) {
      try { data = await call(); break; } catch (e) {
        if (!(e instanceof ModelError) || e.status !== 429 || i >= 5) throw e;
        await new Promise((r) => setTimeout(r, 30_000 + Math.random() * 15_000));
      }
    }
    const text = data?.choices?.[0]?.message?.content;
    if (data?.choices?.[0]?.message === undefined) throw new ModelError(200, JSON.stringify(data));
    const u = data.usage ?? {};
    return [text || "", { prompt_tokens: u.prompt_tokens ?? 0, completion_tokens: u.completion_tokens ?? 0 }];
  }
}

export class Transcriber implements TranscriberLike {
  baseUrl: string;
  constructor(baseUrl: string, private apiKey: string, public name: string, private timeoutS = 120) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async transcribe(audio: Uint8Array, filename: string): Promise<[string, Usage]> {
    const form = new FormData();
    form.append("file", new Blob([audio as unknown as ArrayBuffer]), filename);
    form.append("model", this.name);
    form.append("language", "it");
    form.append("temperature", "0");
    const data = await post(`${this.baseUrl}/audio/transcriptions`, this.timeoutS, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });
    return [data?.text ?? "", { ...ZERO }];
  }
}

/** Serves data/mock/<message_id>.json, keyed by the id in the <message> tag of the prompt. */
export class MockModel implements ChatLike {
  name = "mock";
  dir: string;
  constructor(mockDir?: string) { this.dir = mockDir ?? join(ROOT, "data", "mock"); }

  async generate(messages: ChatMessage[]): Promise<[string, Usage]> {
    const content = messages.filter((m) => typeof m.content === "string").map((m) => m.content as string).join(" ");
    const m = /<message id="([^"]+)"/.exec(content);
    const f = m ? join(this.dir, `${m[1]}.json`) : null;
    const text = f && existsSync(f) ? readFileSync(f, "utf8") : "[]";
    return [text, { ...ZERO }];
  }
}

export type FakeAnswer = string | Error;
type FakeAnswers = FakeAnswer | FakeAnswer[] | Record<string, FakeAnswer> | ((m: ChatMessage[]) => FakeAnswer);

/** answers: a list (consumed in order, last repeats), a dict {sha(last user content): answer}, or a function. */
export class FakeModel implements ChatLike {
  name = "fake";
  calls: ChatMessage[][] = [];
  constructor(private answers: FakeAnswers = "[]") {}

  async generate(messages: ChatMessage[]): Promise<[string, Usage]> {
    this.calls.push(messages);
    let a = this.answers;
    if (typeof a === "function") a = a(messages);
    else if (Array.isArray(a)) a = a.length > 1 ? a.shift()! : a[0];
    else if (typeof a === "object" && !(a instanceof Error)) {
      const last = messages[messages.length - 1].content;
      a = a[sha(typeof last === "string" ? last : JSON.stringify(last))];
    }
    if (a instanceof Error) throw a;
    return [a as string, { prompt_tokens: 10, completion_tokens: 5 }];
  }
}

export class FakeTranscriber implements TranscriberLike {
  name = "fake-whisper";
  calls: string[] = [];
  constructor(private answers: FakeAnswer | Record<string, FakeAnswer> = "ciao") {}

  async transcribe(audio: Uint8Array, filename: string): Promise<[string, Usage]> {
    this.calls.push(filename);
    let a = this.answers;
    if (typeof a === "object" && !(a instanceof Error)) a = a[sha(audio)];
    if (a instanceof Error) throw a;
    return [a, { ...ZERO }];
  }
}
