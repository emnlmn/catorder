"""Placeholder photos of handwritten lists, from data/messages/<id>.transcription.txt (Pillow)."""
import pathlib, random
from PIL import Image, ImageDraw, ImageFont, ImageFilter

M = pathlib.Path(__file__).resolve().parent.parent / "data" / "messages"
FONT = "/System/Library/Fonts/Supplemental/Bradley Hand Bold.ttf"
INK = {"ph-001": (30, 40, 110), "ph-002": (20, 20, 20), "ph-003": (60, 30, 30), "ph-004": (20, 60, 40)}

def make(path: pathlib.Path):
    rnd = random.Random(path.stem)
    lines = path.read_text().splitlines()
    w, h = 1000, 140 + 120 * len(lines)
    img = Image.new("RGB", (w, h), (244, 240, 226))
    d = ImageDraw.Draw(img)
    for y in range(110, h, 120):  # ruled lines
        d.line([(40, y), (w - 40, y)], fill=(190, 205, 225), width=2)
    ink = INK.get(path.stem.split(".")[0], (20, 20, 20))
    for i, line in enumerate(lines):
        font = ImageFont.truetype(FONT, rnd.randint(54, 64))
        d.text((70 + rnd.randint(-6, 14), 40 + 120 * i + rnd.randint(-5, 5)), line, font=font, fill=ink)
    img = img.rotate(rnd.uniform(-2.5, 2.5), expand=True, fillcolor=(244, 240, 226), resample=Image.BICUBIC)
    img = img.filter(ImageFilter.GaussianBlur(0.6))
    img.thumbnail((1600, 1600))
    img.save(path.with_name(path.name.split(".")[0] + ".jpg"), quality=85)

for f in sorted(M.glob("ph-*.transcription.txt")):
    make(f)
    print("wrote", f.name.split(".")[0] + ".jpg")
