---
target: "the order-desk UI: Chats, Forecast, Orders, Catalog"
total_score: 28
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 4
target_identity: "file:/Users/emenon/Code/catorder/public/index.html"
target_fingerprint: "sha256:e46657a112adc23b5787fe6a2c516994bfbe3d94fb6442b7fb496a9e040154a9"
target_path: /Users/emenon/Code/catorder/public/index.html
timestamp: 2026-10-18T02-51-13Z
slug: public-index-html
closed: true
---
Method: dual-agent, split by surface (A: crit-chats · crit-pages · crit-system, design review and system audit · B: crit-detector, detector and browser measurements), all on Sonnet, isolated from each other. Target: the order-desk UI (public/index.html with forecast.html, orders.html, catalog.html, app.css, ui/app.ts), run 2026-10-18 02:55–04:25 on 6b24c60.

## Design Health Score

| # | Heuristic | Chats | Forecast · Orders · Catalog | Key issue |
|---|-----------|-------|------------------------------|-----------|
| 1 | Visibility of System Status | 3 | 3 | opened message often off-screen; a failed first load still said "Synced just now" |
| 2 | Match System / Real World | 3 | 3 | "Seen" for a price flag; a Total that silently skips an unpriced line |
| 3 | User Control and Freedom | 3 | 3 | Esc in the reply box or a dialog threw you out of the chat; Sync collapsed open orders |
| 4 | Consistency and Standards | 3 | 3 | three state words for one order state, five outline-button recipes, two footnote styles |
| 5 | Error Prevention | 3 | 3 | "All 6 lines matched" while two lines were still open |
| 6 | Recognition Rather Than Recall | 3 | 3 | shortcuts only in aria; phone tables lose their headers |
| 7 | Flexibility and Efficiency | 3 | 2 | no search or sort on 79 products / 41 orders; tabs without arrow keys |
| 8 | Aesthetic and Minimalist Design | 3 | 3 | phone headers eat 22% of a chat; Forecast needs 3 rows of furniture before data |
| 9 | Error Recovery | 2 | 2 | half-width toast over ink bubbles; "Reload the page" with no retry |
| 10 | Help and Documentation | 2 | 3 | nothing explains Seen/Later, the ticket or the shortcuts |
| **Total** | | **28/40** | **28/40** | **Good** |

## Design Specificity Verdict

Authored where it matters. The black band asking one question at a time, the customer's words lit green and tied to the order line they became, the ticket stub hooked to its message by an elbow, and the live reading trace belong to this product and could not be lifted onto another. The chrome around them (Inter, 1px lines, tables, pills) is deliberately category-standard SaaS, as the owner chose on 17 Oct; its weakness was not genericness but drift: the same role styled four ways, cartoon-era leftovers (1.5px ink pills, 2px photo borders, unused Rubik/Titan files), and a stale DESIGN.md that still describes the abandoned cartoon world. Detector: 27 static findings, 22 false positives caused by that stale DESIGN.md, the rest harmless (rail width transition, live-state pulse) plus one off-scale 4px radius.

## Overall Impression

The product idea reads in seconds on desktop. The defects were at the edges: tablet and 1001–1200px widths, phones at 320, the projector, and states nobody demos (failed loads, long names, unpriced lines). The single biggest opportunity was trust: the panel claimed "all lines matched" while the band was asking about two of them.

## What's Working

1. The band: one question, "n of m" and a 3px queue bar; its answer cell is exactly the order column (x 1120–1420 at 1440), the question starts on the conversation's left edge.
2. Reference pages share one frame to the pixel: title, lede, toolbar and table on one left edge at every width; numbers right-aligned to one edge with tabular figures.
3. Chat list rows: avatar centred on the row, name/time baselines within 0.4px, time and status on one right edge.

## Priority Issues

- **[P0 on tablets] Chat view: the newest messages are unreachable at 701–1000px.** Regression of 955f196: the body stays a grid from 701px, so the height chain never closed and #msgs could not scroll. Fix: `align-items:stretch` on `body[data-v=chat]`. Command: $impeccable harden.
- **[P1] Opening a chat lands off the opened message** (8 of 20 messages not visible at 1440, 9 at 390): the thread render pinned to the newest message, and `offsetTop` inside `.og` under-scrolled. Fix: place the open message on first paint and when the thread lands. Command: $impeccable harden.
- **[P1] "All N lines matched to the catalogue" while lines were still to check**: the count ignored `check` lines. Fix: count them; the bold "N lines to check before you can confirm" fires. Command: $impeccable clarify.
- **[P1] Narrow-width breakage**: Forecast model badge wider than the phone (page panned sideways), Forecast tabs on two lines, Orders card dates overprinting "Lines", SKUs split at the hyphen, voice player and order ticket outside a narrow column, Clear chat over long names at 1001–1100px, list previews cut mid-glyph without ellipsis. Command: $impeccable adapt.
- **[P1] The projector (1920) does not step up**: Chats stayed at 14/13/12/11px and the reference pages stopped at 1280px with 652px blank. Command: $impeccable typeset.

## Persona Red Flags

**Casey (distracted mobile user):** the search field was 14px, so iOS zoomed the page on focus; "‹ Chats", "Details", "Show steps" were 21–22px tall targets; band buttons 40px; the app header could never scroll away inside a chat (187px of chrome on a 844px phone).
**Sam (keyboard / low vision):** Send and the voice play button had lime focus rings at 1.3–1.6:1 on white; the price on the asked line was 4.05:1 on green; tabs had no arrow keys; focus was lost after a filter chip or Sync.
**Jordan (first-time judge):** the thread did not mark which message the band was about; a confirmed-looking Total ignored an unpriced line; after the last answer the band said "Ready." while pill, ticket and list said "Check".

## Minor Observations

Four uppercase micro-label recipes; eight type sizes within 11–20px; ten line-height values; colour literals duplicating tokens (#5a6366 vs --muted, #A0E249 vs --eye); `.wait` and `.bar` class collisions (transcribing text centred with 40px padding, demand bars 6px above their rows); Export dialog double hairlines; dead CSS from the old order screen, sidebar inbox and customers table; 409 in the console when a customer has under two orders (no visible effect).

## Questions to Consider

- Should 1001–1180px (iPad landscape, 1024×768 projectors) get the stepped list > chat > detail layout instead of a 332px conversation?
- What would a two-line legend for the band ("Seen", "Later", the shortcuts) cost against the one-question rule?
- Is it time to regenerate DESIGN.md from the live CSS so every future review stops measuring against the cartoon world?
