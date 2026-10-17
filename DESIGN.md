---
name: CatOrder
description: Black-and-white rubber-hose cartoon on paper, one green accent for "look here", one black decision band asking one question at a time.
colors:
  ink: "#0F1719"
  paper: "#FFFFFF"
  cat-eye-green: "#A0E249"
  muted: "#5A6163"
  muted-on-ink: "#B9C1C2"
typography:
  display:
    fontFamily: "Titan One, ui-rounded, system-ui, sans-serif"
    fontSize: "58px"
    fontWeight: 400
    lineHeight: 1.1
    letterSpacing: "0.01em"
  headline:
    fontFamily: "Titan One, ui-rounded, system-ui, sans-serif"
    fontSize: "32px"
    fontWeight: 400
    lineHeight: 1.1
    letterSpacing: "0.01em"
  question:
    fontFamily: "Titan One, ui-rounded, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 400
    lineHeight: 1.15
    letterSpacing: "0.01em"
  title:
    fontFamily: "Titan One, ui-rounded, system-ui, sans-serif"
    fontSize: "26px"
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: "0.01em"
  body:
    fontFamily: "Rubik, ui-sans-serif, system-ui, sans-serif"
    fontSize: "19px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "Rubik, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 500
    lineHeight: 1.45
rounded:
  sm: "8px"
  md: "12px"
  lg: "18px"
  xl: "22px"
  logo: "24%"
  full: "999px"
spacing:
  xs: "8px"
  sm: "12px"
  md: "20px"
  lg: "40px"
  gutter-mobile: "16px"
components:
  button-pick:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "44px"
  field:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "44px"
  band:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    padding: "12px 36px"
  number-plate:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.xl}"
    padding: "18px 40px 20px"
  pill-outline:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "0 14px"
    height: "44px"
  pill-outline-open:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
  play-pill:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "0 15px 0 5px"
    height: "38px"
  asked-words:
    backgroundColor: "{colors.cat-eye-green}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "1px 5px"
  toast:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.md}"
    padding: "12px 18px"
---

# Design System: CatOrder

## Overview

**Creative North Star: "The Cartoon Sign"**

CatOrder looks like a 1920s-30s Felix the Cat cartoon turned into a wayfinding sign: ink on paper, round shapes, thick outlines, and exactly one question on screen at a time. The page is paper white. The customer's own words sit on top, the order is a plain list below them, and a single black band pinned to the bottom asks the next decision. The cat logo is the only picture in the product.

Everything is two-tone. Ink (#0F1719) and paper (#FFFFFF) carry every surface, and the cat's green eyes (#A0E249) appear only where the person should look: the words being asked about, the line they belong to, and the live dot. Titan One speaks (names, questions, numbers); Rubik reads (everything else). Controls are quiet and round, with thick ink outlines when they are outlined at all.

The system is dense with type and light on ornament. It refuses the three-column inbox/message/order layout and the AI-chat clone: there is no chat thread, no cards grid, no gradient, no shadow.

**Key Characteristics:**
- Ink on paper; one green accent reserved for "look here".
- One black decision band, fixed at the bottom, asking one question.
- Titan One for names, questions and numbers; Rubik for text.
- Round forms: pills, discs, soft-cornered buttons, a 24% rounded logo with an ink outline.
- Flat: depth comes from inversion (black against white), never from shadow.
- Compact, light type: 19px body, 28px question, 20px quantity; Rubik at 400–500, 600 only for a line to check.

## Colors

A two-tone palette with one signal color; the black band and number plate are the heaviest things on screen.

### Primary
- **Cat-Eye Green** (#A0E249): the highlighter. Fills the asked words in the customer's message, the order line being asked about, and the live dot. Text on it is always ink. It is never a button, border, or decoration.

### Neutral
- **Felix Ink** (#0F1719): text, outlines, the decision band, the number plate, the open inbox pill, the selected inbox row, the toast. A blue-leaning near-black.
- **Paper White** (#FFFFFF): the page, button faces on the band, the inbox panel.
- **Pencil Grey** (#5A6163): secondary text on paper (meta, notes, removed lines, placeholders).
- **Ghost Grey on Ink** (#B9C1C2): secondary text on the black band and plates (sub-line, step count, duration).

Hover is a mix of ink into paper (8% on paper rows and pills, 12% on band buttons); no other tints exist.

### Named Rules
**The Look-Here Rule.** Green marks the one thing to look at: asked words, the matching line, the live dot. If two things are green and they are not the same question, one is wrong.
**The Two-Tone Rule.** Every surface is ink or paper. Grey is for text only, never for surfaces or borders.

## Typography

**Display Font:** Titan One (self-hosted woff2, with ui-rounded, system-ui)
**Body Font:** Rubik 400-700 (self-hosted woff2, with ui-sans-serif, system-ui)

**Character:** Titan One is fat, round and cartoon-poster loud, so it is kept for the few things that speak. Rubik is rounded and sturdy and stays legible at 16px. Rubik replaced Atkinson Hyperlegible, whose slashed zero printed "2Ø cl" in product names.

### Hierarchy
- **Display** (Titan One 400, 46px / 58px at 1600px+, 1.1): the waiting-screen invitation.
- **Number** (Titan One, 64px, 1): the WhatsApp number on its black plate.
- **Headline** (Titan One, 32px / 38px, 1.1): the customer name on an order.
- **Question** (Titan One, 28px, 1.15): the band question; steps down to 24px past 32 characters and 20px past 60, because a flag sentence is not a headline.
- **Title** (Titan One, 22px brand / 20px quantities, 1.2): the brand name and line quantities.
- **Body** (Rubik 400, 19px, 1.45): the customer's words and line names; buttons and fields 17px Rubik 500.
- **Label** (Rubik 500, 14–15px): nav, inbox names, pills, alternatives; 14px Rubik 400 for notes, meta, footers and sub-lines. Bold (700) is not used; 600 marks only a line to check.

Sizes step up at 1600px+ (body 22px, question 32px, labels 16px) and down at 700px (headline and question 26px, number 36px).

### Named Rules
**The Speak/Read Rule.** Titan One is for what the product says or counts; Rubik is for what the customer said and what is listed. Never set running text in Titan One, and never set it in bold synthesis (font-synthesis is off).

## Layout

One centred column (max 880px, 1040px at 1600px+) with 36px side padding (44px at 1600px+, 16px under 700px). The top bar holds logo, brand, an inbox pill, and the model and hardware line pushed right (hidden on mobile). The waiting screen centres a 176px logo, the invitation, the number plate, one muted line, and a small "No signal?" fallback. The order screen stacks the customer, play pill and meta, the original (photo beside text above 900px, stacked below), then the list.

The list is a subgrid of quantity and product columns; rows bleed 12px outside the column so a highlighted row's rounded green fill aligns text with the column edge. The page bottom pads to the band's height so nothing hides behind it. The band's inner row is max 880px (1100px at 1600px+) and goes to a two-column grid (arrow, words) with controls full width on mobile. Rhythm is 8 / 12 / 20 / 40px.

## Elevation & Depth

Flat. There are no shadows, gradients or blurs anywhere. Depth is inversion: the band, number plate, open pill, selected inbox row, play pill and toast flip to ink-on-paper-text. The inbox panel floats over the page with a 2.5px ink outline instead of a shadow. Hover is a tint; press is a 1px downward shift on band buttons.

### Named Rules
**The Outline-Not-Shadow Rule.** A thing that floats gets a 2.5px ink outline and a paper fill. A thing that matters gets an ink fill.

## Shapes

Round, hand-drawn-feeling geometry: full pills (999px) for the inbox and play controls, 18px on band buttons and fields, 22px on the number plate, 20px on the inbox panel, 12px on photos, toast and row highlights, 8px on highlighted words. The logo is a 24% squircle with a 2px ink border (4px at 176px); the photo of the customer's list wears a 2.5px ink border. Outlines are 2.5px on pills and panels. Focus is a 3px ink ring with 3px offset, green on the band.

## Components

### The Decision Band (signature)
Fixed full-width black bar at the bottom, max 80vh. A white disc with an upward arrow, the question in Titan One, an optional step count ("n of m", ghost grey, top right), an optional sub-line, optional underlined text alternatives, then the controls. One question at a time; the queue ends in "Ready." with the Confirm button, or "Nothing to order". Announced as a polite live region.

### Buttons (band)
- **Shape:** soft rounded rectangle (18px), 60px tall (72px at 1600px+), 0 28px padding.
- **Pick:** paper fill, ink text, Rubik 17px medium. Hover mixes 12% ink in; active shifts down 1px. Full width on mobile.
- **Reply bubble:** our side of the chat, right-aligned with the tail bottom-right. A draft is paper with a dashed ink outline and an editable text (green ring while typing, ⌘ Enter sends); a sent reply is ink with a check in its stamp. The band shows a send glyph while a reply waits and a check once the order is confirmed.
- **Suggestion:** a pick with a second line in 13px Pencil Grey saying why it is offered ("in their last 6 orders", "sold by kg"); a small green eye marks a product this customer already orders. Suggestions are offered before the operator searches: the matcher's candidates, or else the closest catalogue products for the customer's words; search opens already filled with those words.
- **Alternative:** no fill, paper text, bold 16px, 2px underline with 4px offset.

### Inputs / Fields
- **Style:** paper fill, no border, 18px radius, 60px tall, 24px Rubik, grey placeholder. Lives only inside the band, beside a Set button.
- **Focus:** green ring on the band (the global 3px ring switches to green).

### Pills
- **Inbox pill:** 44px, paper fill, 2.5px ink outline, bold 16px with a small line-icon; hover tints 8%; open state inverts to ink.
- **Play pill:** ink fill, a paper disc holding a 12px play glyph, duration in ghost grey.

### Number Plate
Ink rounded plate (22px) holding the WhatsApp number in 64px Titan One, with the green live dot pulsing (2.4s, down to 30% opacity).

### Order List
Quantity in Titan One 26px, product in Rubik 24px, an optional 16px grey note. A row being asked about gets a green wipe fill; a removed row is grey and struck through with a 2px line. The customer's message highlights asked words the same way.

### Inbox Panel
Paper panel, 2.5px ink outline, 20px radius, rows of icon, name, time and status; the selected row inverts to ink.

### Toast
Ink pill, paper 16px text, centred above the band, fades in 120ms.

### Motion
Short and functional: wipe (220ms) for green fills, rise (200ms, 8px) for rows, lift (300ms, 16px) for the order screen, fade (150ms), pulse for the live dot. All ease-out. All disabled under prefers-reduced-motion.

## Do's and Don'ts

### Do:
- **Do** keep every surface ink or paper; use grey only for text.
- **Do** use Cat-Eye Green only to mark where to look, always under ink text.
- **Do** ask one question at a time in the band, in Titan One, with white answer buttons.
- **Do** outline floating or quiet controls at 2.5px ink; fill the ones that matter with ink.
- **Do** keep touch targets at 44px or more (60px on the band).
- **Do** keep the logo the only picture; the customer's photo is content, not decoration.

### Don't:
- **Don't** add shadows, gradients, blurs or a second accent color.
- **Don't** use green for buttons, borders, icons or decoration.
- **Don't** set running text in Titan One, or fake its bold.
- **Don't** build a three-column inbox/message/order layout or a chat thread.
- **Don't** add a second persistent bar or a modal for decisions; the band is the only place the product asks.
- **Don't** show a guess as fact: doubt is a question in the band.
