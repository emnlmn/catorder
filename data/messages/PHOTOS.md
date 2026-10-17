# Photos

The `.jpg` files are generated placeholders (`scripts/make_photos.py`). Replace each with a real photo of a handwritten list, long side at most 1600 px, written by hand exactly as in the matching `.transcription.txt`. No real names, phone numbers or addresses on the paper. In ph-002, write the second word of the farina line so that it is hard to read; the transcription has it as `[?]`.

| File | Customer | Write this, one line per row |
|---|---|---|
| ph-001.jpg | Bar Ponte Rosso | x lunedi / caffe 4 cs / acqua nat 6 cs / acqua friz 4 cs / cola 3 cs / lager 2 cs / tovaglioli 33 2 cs / bicchierini 1 cs |
| ph-002.jpg | Ristorante Il Gelsomino | gelsomino - x lunedi / pelati 3 cs / spaghetti 4 cs / farina [?] 5kg x4 (one word unreadable) / mozzarella 4 kg / olio 5lt x2 / acqua nat 5 cs |
| ph-003.jpg | Salumeria Mulino Vecchio | x giovedi / cotto 4 kg / crudo 3 kg / speck 2 kg / taleggio 2 kg / gorgonzola 2 kg / mozzarella fiordilatte 3 kg / mortadella 2 kg |
| ph-004.jpg | Emporio Nuovo Borgo | nuovo borgo / x martedi / acqua nat 1l 6 cs / cola 3 cs / penne 3 cs / passata 2 cs / caffe 2 cs / olio 1 l 6 pz |

If a real photo ends up reading differently, rewrite the `.transcription.txt`, the `data/mock/<id>.json` quotes and `expected.json` to match, then run `python3 scripts/check_data.py`.
