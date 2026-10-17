"""Synthesise data/messages/<id>.mp3 from <id>.script.txt (ElevenLabs; macOS say + ffmpeg as fallback).

Run: zsh -ic 'source ~/.zshrc >/dev/null 2>&1; python3 scripts/make_voice.py'
ELEVENLABS_API_KEY comes from the environment and is never printed.
"""
import json, os, pathlib, ssl, subprocess, sys, urllib.request

M = pathlib.Path(__file__).resolve().parent.parent / "data" / "messages"
API = "https://api.elevenlabs.io/v1"
KEY = os.environ.get("ELEVENLABS_API_KEY", "")
CTX = ssl.create_default_context(cafile="/etc/ssl/cert.pem" if os.path.exists("/etc/ssl/cert.pem") else None)  # python.org builds lack a CA bundle

def call(path, body=None):
    req = urllib.request.Request(API + path, data=body and json.dumps(body).encode(), headers={"xi-api-key": KEY, "Content-Type": "application/json", "Accept": "audio/mpeg" if body else "application/json"})
    with urllib.request.urlopen(req, timeout=120, context=CTX) as r:
        return r.read()

def fallback(text, out):
    aiff = out.with_suffix(".aiff")
    subprocess.run(["say", "-v", "Alice", "-o", str(aiff), text], check=True)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(aiff), str(out)], check=True)
    aiff.unlink()

def main():
    scripts = sorted(M.glob("vo-*.script.txt"))
    voices = []
    if KEY:
        try:
            voices = [v["voice_id"] for v in json.loads(call("/voices"))["voices"]]
        except Exception as e:  # ponytail: any API failure falls back to say, no retries
            print("voice list failed:", type(e).__name__)
    chars = 0
    for i, f in enumerate(scripts):
        out = f.with_name(f.name.split(".")[0] + ".mp3")
        if out.exists():
            continue
        text = f.read_text().strip()
        try:
            if not voices:
                raise RuntimeError("no voices")
            out.write_bytes(call(f"/text-to-speech/{voices[i % len(voices)]}", {"text": text, "model_id": "eleven_multilingual_v2"}))
            chars += len(text)
            print("elevenlabs", out.name)
        except Exception as e:
            print("fallback say", out.name, type(e).__name__)
            fallback(text, out)
    print("characters sent:", chars)

if __name__ == "__main__":
    sys.exit(main())
