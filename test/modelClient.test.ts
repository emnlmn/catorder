import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cachedCall, ModelError, sha } from "../src/cache.ts";
import { ChatModel, FakeModel, MockModel, Transcriber } from "../src/modelClient.ts";
import { EXTRACT_SYSTEM, extractMessages, visionMessages } from "../src/prompt.ts";

let srv: ReturnType<typeof createServer>;
let base = "";
let last: { url?: string; body: string; ctype?: string } = { body: "" };

beforeAll(async () => {
  srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      last = { url: req.url, body: Buffer.concat(chunks).toString("latin1"), ctype: req.headers["content-type"] };
      res.setHeader("content-type", "application/json");
      if (req.url === "/bad/chat/completions") { res.statusCode = 500; res.end("boom"); return; }
      if (req.url?.endsWith("/audio/transcriptions")) { res.end(JSON.stringify({ text: "sei casse" })); return; }
      res.end(JSON.stringify({ choices: [{ message: { content: "[]" } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
afterAll(() => srv.close());

describe("prompt", () => {
  it("matches the Python prototype's prompt text (it keys the cache)", () => {
    const [ex] = JSON.parse(readFileSync(join(import.meta.dirname, "golden", "python-unit", "prompt.json"), "utf8"));
    expect(EXTRACT_SYSTEM).toBe(ex);
  });
  it("adds the retry turns", () => {
    const m = extractMessages({ name: "A", kind: "bar" }, [], [], { id: "x", channel: "whatsapp", received_at: "t" }, "original", "hi", "bad", "prev");
    expect(m).toHaveLength(4);
    expect(m[3].content).toContain("(bad)");
    expect(visionMessages(new Uint8Array([1]))[1].content).toHaveLength(1);
  });
});

describe("ChatModel", () => {
  it("posts and passes reasoning_effort", async () => {
    const [t, u] = await new ChatModel(base + "/", "k", "m", 5, "none").generate([{ role: "user", content: "x" }]);
    expect(t).toBe("[]");
    expect(u).toEqual({ prompt_tokens: 3, completion_tokens: 2 });
    expect(JSON.parse(last.body).reasoning_effort).toBe("none");
  });
  it("raises ModelError on http error", async () => {
    await expect(new ChatModel(base + "/bad", "k", "m").generate([])).rejects.toMatchObject({ status: 500 });
  });
  it("transcribes via multipart", async () => {
    const [t] = await new Transcriber(base, "k", "w").transcribe(new Uint8Array([1, 2]), "a.mp3");
    expect(t).toBe("sei casse");
    expect(last.ctype).toContain("multipart/form-data");
  });
});

describe("mock and fake", () => {
  it("MockModel reads data/mock by message id", async () => {
    const [t] = await new MockModel().generate([{ role: "user", content: '<message id="wa-001" channel="x"' }]);
    expect(t).toBe(readFileSync(join(import.meta.dirname, "..", "data", "mock", "wa-001.json"), "utf8"));
  });
  it("FakeModel consumes a list and repeats the last", async () => {
    const f = new FakeModel(["a", "b"]);
    expect((await f.generate([]))[0]).toBe("a");
    expect((await f.generate([]))[0]).toBe("b");
    expect((await f.generate([]))[0]).toBe("b");
  });
});

describe("cachedCall", () => {
  it("caches, honours offline and refresh", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cache-"));
    let n = 0;
    const fn = async () => { n++; return ["t", { prompt_tokens: 1, completion_tokens: 1 }] as [string, { prompt_tokens: number; completion_tokens: number }]; };
    const o = { dir, offline: false, refresh: false };
    expect((await cachedCall(o, "extract", "m", "i", "c", fn)).cached).toBe(false);
    expect((await cachedCall(o, "extract", "m", "i", "c", fn)).cached).toBe(true);
    expect(n).toBe(1);
    await cachedCall({ ...o, refresh: true }, "extract", "m", "i", "c", fn);
    expect(n).toBe(2);
    await expect(cachedCall({ ...o, offline: true }, "extract", "m", "other", "c", fn)).rejects.toBeInstanceOf(ModelError);
    expect((await cachedCall({ ...o, dir: null }, "extract", "m", "i", "c", fn)).cached).toBe(false);
  });
  it("sha matches the Python prototype", () => {
    expect(sha("a", "b", 1)).toBe(readFileSync(join(import.meta.dirname, "golden", "python-unit", "sha.txt"), "utf8").trim());
  });
});
