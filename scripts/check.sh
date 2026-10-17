#!/usr/bin/env bash
# Typecheck, tests, a secret scan over tracked and untracked files (never .env), and no .env in the git index.
set -u
cd "$(dirname "$0")/.."
fail=0

npx tsc --noEmit || fail=1
npx vitest run || fail=1

# key patterns; this script itself is excluded
pat='sk-[A-Za-z0-9_-]{16,}|xi-api-key["'"'"' ]*[:=]["'"'"' ]*[A-Za-z0-9]{12,}|(ELEVENLABS|MODEL|TRANSCRIBE)_API_KEY[ ]*=[ ]*["'"'"']?[A-Za-z0-9_-]{12,}|sk_[a-f0-9]{32,}|hf_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}'
hits=$(git ls-files -co --exclude-standard -- . ':!:.env' ':!:scripts/check.sh' ':!:*.mp3' ':!:*.jpg' ':!:*.png' ':!:*.db' ':!:*package-lock.json' ':!:node_modules' \
  | grep -v '^\.env$' | xargs grep -InE "$pat" 2>/dev/null || true)
if [ -n "$hits" ]; then echo "possible secret:"; echo "$hits"; fail=1; else echo "secret scan: clean"; fi

if git ls-files --error-unmatch .env >/dev/null 2>&1 || git ls-files | grep -qE '(^|/)\.env$'; then
  echo ".env is in the git index"; fail=1
else
  echo ".env not in the index"
fi

[ $fail -eq 0 ] && echo "check: ok" || echo "check: FAILED"
exit $fail
