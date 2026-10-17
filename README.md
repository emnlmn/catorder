# CatOrder

Wholesale customers order the way they talk: a WhatsApp message, a voice note, a photo of a handwritten list. CatOrder reads them with Gemma served on AMD, matches every line to the catalogue, resolves "the usual" from the customer's order history, checks what they ask for against their agreed terms, and hands the order desk a draft order where every line points to the words it came from. A person confirms; nothing is sent.

Built at the AMD Developer Hackathon ACT III (17–18 October 2026, Milan), Track 3 · Reinvent Commerce. Synthetic data only. MIT. `PRODUCT.md` is the product, `SPEC.md` the build specification.

## Stack

Node 22, TypeScript (strict, ESM), Hono with `@hono/node-server`, `node:sqlite`, `tsx` to run, `vitest` for tests. The frontend is plain TypeScript compiled by `tsc` to `public/app.js`, no framework.

## Run

```
npm install
npm run build:ui     # compiles ui/app.ts to public/app.js
cp .env.example .env   # optional, see below
npm start            # http://localhost:7860
npm run demo         # mock mode, date fixed at 2026-10-18
npm test             # vitest
npm run typecheck    # tsc --noEmit
npm run eval         # 20 prepared messages against data/expected.json
./scripts/check.sh   # typecheck + tests + secret scan
```

With `MODEL_BASE_URL` empty (or `CATORDER_MOCK=1`) the app runs in mock mode: the extraction answers in `data/mock/` are hand-written, so matching, "the usual", flags and export work with no model and no network. The mock numbers show the pipeline handles a good model's answers; they say nothing about Gemma.

Docker:

```
docker build -t catorder .
docker run -p 7860:7860 -e CATORDER_MOCK=1 catorder
```

## Environment variables

Read from the process environment, or from `.env` (real variables win).

| variable | meaning |
|---|---|
| `MODEL_BASE_URL`, `MODEL_API_KEY`, `MODEL_NAME` | any OpenAI-compatible chat endpoint |
| `MODEL_VISION` | `0` if the model takes no images: photos use the committed transcription |
| `MODEL_REASONING_EFFORT` | `none` for models that think first (Ollama gemma4, qwen3); empty = not sent |
| `MODEL_PRICE_IN_PER_M`, `MODEL_PRICE_OUT_PER_M` | USD per 1M tokens, for the cost estimate |
| `MODEL_TIMEOUT_S`, `MODEL_HARDWARE` | request timeout; top bar text |
| `TRANSCRIBE_BASE_URL`, `TRANSCRIBE_API_KEY`, `TRANSCRIBE_MODEL` | `/audio/transcriptions` endpoint; empty = committed transcripts, labelled "from file" |
| `CATORDER_DB`, `CATORDER_TODAY` | SQLite path; fixed date (`YYYY-MM-DD`) |
| `CATORDER_OFFLINE`, `CATORDER_REFRESH` | serve only cache and committed readings / ignore the cache |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `PUBLIC_URL`, `WHATSAPP_PHONE_MAP`, `CATORDER_INBOX_DIR` | live WhatsApp, see below |
| `CATORDER_MOCK`, `CATORDER_DATA_DIR`, `CATORDER_CACHE_DIR`, `PORT` | force mock; data and cache dirs; port (default 7860) |

## Models on AMD

- **AMD Token Factory** (OpenAI-compatible): `MODEL_BASE_URL=https://developer.amd.com.cn/radeon/api/v1`, `MODEL_NAME=Gemma-4-31B-IT` and your `MODEL_API_KEY`. Add `MODEL_HARDWARE="AMD Instinct MI300X via AMD Token Factory"` for the top bar.
- **vLLM on an MI300X**: `vllm serve google/gemma-3-27b-it`, then `MODEL_BASE_URL=http://<host>:8000/v1`. Whisper served the same way reads voice notes via `TRANSCRIBE_*`.
- **Ollama for development**: `MODEL_BASE_URL=http://localhost:11434/v1`, `MODEL_API_KEY=ollama`, `MODEL_NAME=gemma3:12b`.

## Live WhatsApp through the Twilio Sandbox

A real WhatsApp message to Twilio's sandbox number appears in the inbox within seconds and is read like any other. Nothing is ever replied to the customer.

1. Create a Twilio account. Console, Messaging, Try it out, Send a WhatsApp message: it shows the sandbox number and a `join <two-words>` code. Send that code from your phone. The join expires after 72 hours without messages.
2. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `PUBLIC_URL` and `WHATSAPP_PHONE_MAP` (see `.env.example`). Phone numbers live only in the environment and in the local database (git-ignored), never in a committed file; the number a message came from is kept so the reply can go back to it. A number not in the map is kept under the customer "Numero sconosciuto".
3. For local development, `cloudflared tunnel --url http://localhost:7860` prints a public https URL. Use it as `PUBLIC_URL`, then start the app.
4. In the Sandbox settings, set "When a message comes in" to `<PUBLIC_URL>/webhook/whatsapp`, method POST.

Text, voice notes (ogg, opus, amr, mp3) and photos (jpeg, png, webp) up to 10 MB are accepted; the media is saved in `CATORDER_INBOX_DIR` (default `data/inbox/`, git-ignored). Without `TWILIO_AUTH_TOKEN` the route answers 503.

Replies go back the same way: after a read, "Reply to …" (or "Ask the customer" on a doubtful line) has the model draft the answer into the chat, and the operator edits it and presses Send. It goes out from `TWILIO_WHATSAPP_FROM` (default the sandbox number, +14155238886) to the number the message came from (else the customer's number in `WHATSAPP_PHONE_MAP`); a customer with no number gets a demo send that delivers nothing, and the bubble says so.

## Numbers

`npm run eval` on the 20 synthetic messages, Gemma-4-31B-IT on AMD Token Factory, 17 Oct 2026:

| | messages | line precision | line recall | orders right | candidates hit | flags found | false flags | unverified lines |
|---|---|---|---|---|---|---|---|---|
| overall | 20 | 100% (70/70) | 100% (70/70) | 20/20 | 100% | 8/8 | 1 | 0 |
| WhatsApp | 10 | 27/27 | 27/27 | 10/10 | 100% | 6/6 | 0 | 0 |
| photo | 4 | 26/26 | 26/26 | 4/4 | 100% | 1/1 | 1 | 0 |
| voice | 4 | 14/14 | 14/14 | 4/4 | n/a | 0/0 | 0 | 0 |
| email | 2 | 3/3 | 3/3 | 2/2 | n/a | 1/1 | 0 | 0 |

84k tokens in and 6.6k out for the 20 orders; 21 s mean per message on the live run (photos make two calls). Voice notes are read from committed transcripts: Token Factory has no speech-to-text model yet. The false flag is "olio 5lt" in a photo, marked as ambiguous where the expected answer has one product. The model outputs are cached in `data/cache/`, so the eval and the demo replay them without calling the endpoint.

## Golden tests

CatOrder was first prototyped in Python. `test/golden/` holds that prototype's outputs in mock mode (today 2026-10-18, fresh DB). The tests compare the API against them after dropping volatile fields (ids, timestamps, latency); candidate scores are compared to 3 decimals.

## Data

Everything in `data/` is invented: distributor, customers, products, prices, messages. Voice notes are synthesised with ElevenLabs from the scripts next to them (`scripts/make_voice.py`); the photos are placeholders rendered by `scripts/make_photos.py` until replaced by real handwritten lists (`data/messages/PHOTOS.md`). `scripts/check_data.py` checks the data's consistency.

## License

MIT.
