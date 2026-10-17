# Photos

The `.jpg` files are generated placeholders (`scripts/make_photos.py`). Replace each with a real photo of a handwritten list, long side at most 1600 px, written by hand exactly as in the matching `.transcription.txt`. No real names, phone numbers or addresses on the paper. In ph-002, write the second word of the flour line so that it is hard to read; the transcription has it as `[?]`.

| File | Customer | Write this, one line per row |
|---|---|---|
| ph-001.jpg | Red Bridge Bar | for mon / coffee 4 cs / still water 6 cs / sparkling water 4 cs / cola 3 cs / lager 2 cs / napkins 33 2 cs / coffee cups 1 cs |
| ph-002.jpg | The Jasmine Restaurant | jasmine - for mon / peeled tomatoes 3 cs / spaghetti 4 cs / flour [?] 5kg x4 / mozzarella 4 kg / oil 5l x2 / still water 5 cs (one word unreadable) |
| ph-003.jpg | Old Mill Deli | for thu / cooked ham 4 kg / crudo 3 kg / speck 2 kg / taleggio 2 kg / gorgonzola 2 kg / fior di latte mozzarella 3 kg / mortadella 2 kg |
| ph-004.jpg | New Village Grocery | new village / for tue / still water 1l 6 cs / cola 3 cs / penne 3 cs / passata 2 cs / coffee 2 cs / oil 1 l 6 pc |

If a real photo ends up reading differently, rewrite the `.transcription.txt`, the `data/mock/<id>.json` quotes and `expected.json` to match, then run `python3 scripts/check_data.py`.
