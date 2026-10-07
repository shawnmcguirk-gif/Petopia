#!/bin/bash
# Installs (or reloads) the Petopia engine LaunchAgent, label com.petopia.engine, port 4400 (D1 spec sec 2, A11).
# Copied from Vitalis engine/deploy/install-launchagent.sh. Run through the Axiom runner on the iMac. Reads engine/.env
# at install time and writes the plist (mode 600) into ~/Library/LaunchAgents -- the database URL is never committed.
# Refuses to install with auth switched off, or if something else already listens on 4400.
set -euo pipefail
ENGINE="$HOME/dev/Petopia/engine"
LABEL=com.petopia.engine
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
cd "$ENGINE"
set -a; . ./.env; set +a
[ "${PETOPIA_AUTH:-on}" != "off" ] || { echo "refusing: PETOPIA_AUTH=off in .env"; exit 1; }
[ -n "${PETOPIA_DATABASE_URL:-}" ] || { echo "refusing: PETOPIA_DATABASE_URL missing"; exit 1; }
PORT="${PORT:-4400}"
if ! launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "refusing: something else already listens on :$PORT"; exit 1
fi
NODE=/usr/local/bin/node; [ -x "$NODE" ] || NODE="$(command -v node)"
[ -f dist/src/index.js ] || { echo "build first: npm run build"; exit 1; }
[ -f ../web/dist/index.html ] || { echo "build the web UI first: cd ../web && npm run build"; exit 1; }
ENGINE="$ENGINE" NODE="$NODE" PLIST="$PLIST" LABEL="$LABEL" PORT="$PORT" python3 - <<'PY'
import os, plistlib
d = {
  "Label": os.environ["LABEL"],
  "ProgramArguments": [os.environ["NODE"], "dist/src/index.js"],
  "WorkingDirectory": os.environ["ENGINE"],
  "EnvironmentVariables": {
    "NODE_ENV": "production",
    "PORT": os.environ["PORT"],
    "PETOPIA_DATABASE_URL": os.environ["PETOPIA_DATABASE_URL"],
    "VAULT_ROOT": os.environ.get("VAULT_ROOT", os.path.expanduser("~/Library/CloudStorage/OneDrive-SharedLibraries-onedrive/Documents/Obsidian/household")),
    "PETOPIA_ADMINS": os.environ.get("PETOPIA_ADMINS", ""),
    # S5 inbox (defaults copied from Vitalis's LaunchAgent): OCR on the Alienware over Tailscale, PyMuPDF from the
    # Truehaven venv Vitalis already uses, `claude -p` inside the n8n container (as Vitalis insight.ts).
    "OLLAMA_URL": os.environ.get("OLLAMA_URL", "http://100.79.2.83:11434"),
    "PETOPIA_PYTHON": os.environ.get("PETOPIA_PYTHON", os.path.expanduser("~/dev/Truehaven/extract/.venv/bin/python3")),
    **{k: os.environ[k] for k in ("PETOPIA_CLAUDE_CMD", "PETOPIA_READER_MODEL", "PETOPIA_LOCAL_READER_MODEL", "OCR_MODEL", "PETOPIA_SWEEP_SECONDS",
                                  "PETOPIA_SERVICE_SECRET", "PETOPIA_EVENTS_URL") if os.environ.get(k)},
    **({"PETOPIA_REQUIRE_FEATURE": os.environ["PETOPIA_REQUIRE_FEATURE"]} if os.environ.get("PETOPIA_REQUIRE_FEATURE") else {}),
    **({"PETOPIA_AUTH_VERIFY_URL": os.environ["PETOPIA_AUTH_VERIFY_URL"]} if os.environ.get("PETOPIA_AUTH_VERIFY_URL") else {}),
  },
  "RunAtLoad": True,
  "KeepAlive": True,
  "StandardOutPath": "/tmp/petopia-engine.log",
  "StandardErrorPath": "/tmp/petopia-engine.log",
}
with open(os.environ["PLIST"], "wb") as f:
    plistlib.dump(d, f)
os.chmod(os.environ["PLIST"], 0o600)
PY
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
echo "installed $LABEL on :$PORT (log /tmp/petopia-engine.log)"
