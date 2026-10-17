---
version: 1
slug: "public-index-html"
primary_target: "public/index.html"
related_targets: ["public/app.css","ui/app.ts"]
---

Surface: the CatOrder order-desk page (public/index.html, public/app.css, ui/app.ts). Mode: Operate.

Audience and job: hackathon judges watching a projector and a recorded video; Marta at the order desk at 7:30. In seconds they must see a messy customer message become a checked draft order, every line tied to the customer's words, doubt asked as a question, a person confirming.

Constraints: one screen, no sidebar, fits 1440×900 without scrolling; English UI, customer messages untouched; API unchanged; plain TypeScript, no framework.

Memorable moment: a WhatsApp voice note arrives live, the words appear, the order appears line by line, and one black band asks the only question that matters now.

Open decisions: live voice notes need TRANSCRIBE_*; the WhatsApp number is the Twilio sandbox constant in ui/app.ts.

## Direction contract

THESIS: One question at a time. Customer's words on top, the order as a plain list, one black band at the bottom asking the next decision. Refuses the three-column inbox/message/order layout and the AI-chat clone.

OWN-WORLD: Black and white in the style of Felix the Cat (1920s–30s rubber-hose cartoon): ink #0F1719 on paper white, one accent, the cat's green eyes #A0E249, used only where to look (asked words and line, live dot). Titan One for names, questions, numbers; Rubik for text (replaced Atkinson Hyperlegible, whose slashed zero printed "2Øcl" in product names). Round shapes, thick ink outlines on quiet controls; the logo is the only picture.

STORY: The judge sees the cat and a WhatsApp number; a voice note lands; the words appear, then a short list; the band asks which prosecco, then about the 8%, then Confirm. Every line comes from the words; doubt is a question, never a guess.

FIRST VIEWPORT: Waiting: logo 176px centred with 4px ink border, "Send an order on WhatsApp" 46px, number 64px white on a black rounded plate with a green dot, one muted line, a small "No signal?" line with three prepared messages. Top bar: logo + CatOrder, "N messages" outline pill, model and AMD hardware right. Order: customer 44px, play pill + meta, reading 24px with asked words on green, the list, the run line; full-width black band with a 40px white question and white answer buttons.

FORM: Wayfinding sign system, dealt challenger (not on the grounded list), chosen by the user, distilled and re-skinned to the Felix brand. Seed key 86823db2.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
