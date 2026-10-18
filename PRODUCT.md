# CatOrder

Wholesale customers order the way they talk: a WhatsApp message, a voice note, a photo of a handwritten list. CatOrder reads them with Gemma served on AMD, matches every line to the catalogue, resolves "the usual" from the customer's order history, checks what they ask for against their agreed terms, and hands the order desk a draft order where every line points to the words it came from. Nothing is retyped; nothing is guessed in silence.

Built for the AMD Developer Hackathon ACT III (Track 3, Reinvent Commerce), October 2026. MIT.

## The problem

A regional food and beverage distributor supplies bars, restaurants, delis and grocers. Its customers do not use the B2B portal it paid for. They order on WhatsApp, at eleven at night, after closing:

> "ciao Marta, il solito per venerdì + 6 casse di quello rosso dell'altra volta, niente acqua frizzante stavolta"

A voice note from a café owner driving to the market. A photo of a list written on the back of a delivery note. An email with "same as last week but double the mozzarella".

Every morning someone at the order desk reads each message and retypes it into the ERP, line by line. "Quello rosso dell'altra volta" means opening the customer's last orders to find which red. "Il solito" means remembering. The person who knows every customer's usual is the bottleneck, and when she is on holiday the errors start: the wrong pack size, the sparkling water that was not wanted, a 6 read as a 0 in a photo. Each error is a second delivery, a credit note or a customer who calls a competitor.

This is not a market we imagine. A wholesale owner on the Shopify forum, June 2026: *"Every morning I retype each one into our current order system by hand."* Another: *"They prefer to just email, text or call us… We manually process our B2B customer orders."* The answer every vendor gives is "move them to a portal", and the same owner answers that half of them won't use it anyway. In Italy, the Politecnico di Milano's Digital B2b observatory (June 2026) finds only 7% of companies truly digital in their B2B processes.

The customer will not change. The order desk has to.

## Who it is for

**Marta, order desk.** She works for a distributor of 60 people in Brianza: 140 customers, 60 to 90 orders a day, more than half by WhatsApp, the rest by email and phone. She knows the catalogue and most customers' habits by heart. She does not need a chatbot; she needs the order already typed, with the doubtful lines pointed out, so she spends her time on the doubts and not on the typing.

**Paolo, operations manager or owner.** He buys. He wants fewer wrong deliveries, an order desk that does not depend on one person's memory, and the morning peak handled before the trucks are loaded.

**The sales director**, who sets each customer's discount, wants to know when a customer writes "with the usual 8%" and the agreement says 5%.

## What CatOrder does

1. **Reads what arrives, as it arrives.** A WhatsApp text, a voice note, a photo of a list, an email. A voice note is transcribed and a photo is read into text first, by models on AMD; the person always sees the original next to the text it became.
2. **Turns it into order lines.** Gemma finds each request in the text: a product and a quantity, "the usual", a change to the usual ("no sparkling water this time"), a delivery date, a price or discount request. Each line carries the exact words it came from.
3. **Checks every line in code.** The words must be in the message, or the line does not exist. The product must exist in the catalogue; when the text is vague ("quello rosso dell'altra volta"), code proposes the candidates from the catalogue and from this customer's past orders, and the line is marked uncertain rather than guessed. "The usual" is computed from the customer's order history, not by the model. A quantity far from what this customer usually orders is flagged. A discount or price asked for is compared with the customer's agreed terms.
4. **Hands over a draft order.** Lines that are certain, lines to check with their candidates, flags at the top. Marta fixes what needs fixing, confirms, and exports the order to the ERP. Then Gemma drafts the reply to the customer (a confirmation, or the question about a doubtful line) into the chat; Marta edits it and sends it. CatOrder never sends anything to the customer and never writes to the ERP on its own.

## Why it can be trusted

1. **No words, no line.** Every line cites the exact words of the message it came from, and code verifies they are there. A line the model invents cannot appear.
2. **The model reads, code decides.** The model proposes what was asked. Whether a product exists, what "the usual" is, whether a quantity is unusual and whether a discount goes beyond the terms are computed by code, from the catalogue, the history and the terms.
3. **Doubt is shown, not hidden.** An uncertain match is a question to Marta with its candidates, never a silent pick.
4. **A person confirms every order.** CatOrder prepares; Marta sends to the ERP.
5. **The data stays home.** Prices, terms and customers' habits are the distributor's most sensitive numbers. An open model on the company's own AMD cloud means they never leave.

## The business

**Who pays.** The distributor, per order desk, bought by the owner or the operations manager. In Italy alone there are tens of thousands of wholesale distributors in food and beverage, horeca supplies, building materials, electrical, plumbing, pharmacy, most of them small, most of them on WhatsApp with their customers.

**What it is worth.** Our assumptions, stated, not measured:

| | |
|---|---|
| Orders by message at one distributor | 70 a day |
| Time to read and retype one | 4 minutes, more for photos and voice notes (conservative: Pepper and Choco report 5–8 minutes for food distributors, vendor figures) |
| Order desk time spent retyping | 4.7 hours a day, most of one person's working day |
| One wrong line delivered | a second trip, a credit note, a customer annoyed: €30 to €80 |
| CatOrder | €149 a month (Starter), €299 with forecasts (Pro) |

If CatOrder halves the typing and catches one wrong line a day, it pays for itself many times over; the bigger gain is that the morning no longer depends on the one person who remembers every customer's usual. We argue this; we will report what the eval measures, not a lift we have not seen.

**Why now, and why open models on AMD.** Reading a dialect-laden voice note, a crooked photo of a handwritten list and "the red one from last time" was not possible before multimodal language models. It is now, on two conditions: the cost per order must be negligible, because it runs on every message, and the customer's prices and habits must not leave the company. Gemma served on AMD Instinct meets both. CatOrder measures tokens, latency and cost on every order, so the number is shown, not claimed.

**Against what exists.** A wave of small Shopify apps (ReorderInbox, Draftly and half a dozen others, all launched in mid-2026) turn emailed or pasted orders into draft orders: English, email and PDF first, no voice notes, no memory of the customer, no check against terms. Enterprise order automation (Conexiom, Pepper) serves large distributors with long projects and no public price. B2B portals ask the customer to change, and the customer does not. CatOrder is for the small distributor, in Italian, on WhatsApp, with voice and photos, with "the usual" understood and every line traceable.

**Go to market.** Start with food and beverage distributors serving horeca in northern Italy, where WhatsApp ordering is the norm. The hackathon app is the order desk's screen; the product connects to WhatsApp Business and exports to the common Italian ERPs.

## What we measure

On a fixed set of synthetic customers, catalogue, order history and messages (texts, voice notes, photos) with known correct orders (`data/`, script in `eval/`):

- Lines: products and quantities right over lines expected; orders entirely right.
- Uncertain lines: how often the right product is among the candidates shown.
- Flags: planted problems caught (wrong pack size, unusual quantity, discount beyond terms); false flags.
- Lines shown without verified words: zero by construction, and counted to prove it.
- Per order: tokens, latency, estimated cost on AMD.

## Hackathon scope, and after

**In the hackathon.** One invented distributor with a catalogue of about 80 products, four customers with order histories and agreed terms, about 20 incoming messages (WhatsApp texts in Italian, voice notes, photos of handwritten lists, emails) with planted difficulties; reading on Gemma via AMD Token Factory; the draft order with candidates and flags; confirm and export; the eval and its numbers in the README; a public URL.

**Not in the hackathon.** The WhatsApp Business connection, ERP integration, accounts and permissions, stock availability, delivery planning.

**After.** WhatsApp Business and email as live inboxes. Export to the common Italian ERPs. Stock check at order time.

## Honest limits

- A badly lit photo or a voice note over traffic noise may be read wrong. The original is always next to the text, and an uncertain reading is flagged, but recall is measured and reported, not promised.
- "The usual" is computed from the order history in CatOrder. A customer whose habits changed last week will see last month's usual, marked as such.
- Vague products are proposed, not decided. On a new customer with no history, more lines will be uncertain.
- The hackathon data is synthetic and declared as such. No real customer, product label or message was used.
