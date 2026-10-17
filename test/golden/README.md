# Golden outputs

Captured from the Python app (the oracle) in mock mode: `CATORDER_MOCK=1 CATORDER_TODAY=2026-10-18`, fresh DB.
Files: `health`, `messages` (before reads), `messages-after-read`, `metrics`, `read-<id>` (POST read) and `detail-<id>` (GET after read) for all 20 messages,
`customers-<id>`, `catalog-{prosecco,farina,empty}`, error cases (`*-404`, `*409*`, `patch400*`), the wa-006 flow
(`confirm409`, `confirm`, `confirm-again409`, `reread409`, `export-wa-006.csv|json`, `export409`), the wa-003 PATCH (`patch-wa-003`),
and `python-unit/` (outputs of the pure Python functions on sample inputs).

## Volatile fields (ignore in comparisons)

- `id` of orders, lines and runs (uuid4 hex, 32 chars), and `order_id` on lines; `line_id` in `patch-wa-003.json` and the order id in the CSV first column.
- `created_at`, `confirmed_at` (wall clock), `latency_ms`.
- Message and customer `id`s are stable (from file names) and must match.

`test/parity.ts` exports `normalise(json)`, `normaliseCsv(csv)` and `golden(name)`.
`candidates[].score` is rounded to 3 decimals in Python; compare with `toBeCloseTo(x, 3)` or the same rounding.
