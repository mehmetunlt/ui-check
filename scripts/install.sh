#!/bin/sh
# Builds ui-check and installs it for every project and Claude Code session. The installed copy
# needs nothing from this checkout, so it keeps working if the checkout moves or is deleted:
#   ~/.local/share/ui-check   dist/ui-check.mjs plus playwright-core and @napi-rs/canvas beside it
#   ~/.local/bin/ui-check     the command
#   ~/.config/ui-check/env    OPENROUTER_API_KEY=... (create it once; never committed)
#   ~/.claude/skills/ui-check the skill, from SKILL.md
# Re-run after any change (npm run install:global). Needs Node 22+ and Google Chrome.
set -eu
SRC=$(cd "$(dirname "$0")/.." && pwd)
DEST="${UI_CHECK_HOME:-$HOME/.local/share/ui-check}"
BIN="$HOME/.local/bin/ui-check"
ENV_FILE="$HOME/.config/ui-check/env"
SKILL_DIR="$HOME/.claude/skills/ui-check"

cd "$SRC"
[ -d node_modules/esbuild ] || npm install --no-audit --no-fund --loglevel=error
npm run -s build

mkdir -p "$DEST" "$(dirname "$BIN")" "$(dirname "$ENV_FILE")" "$SKILL_DIR"
cp dist/ui-check.mjs "$DEST/ui-check.mjs"
PKG=$(node -e 'const p=require("./package.json");process.stdout.write(JSON.stringify({name:"ui-check-runtime",private:true,type:"module",dependencies:p.dependencies},null,2)+"\n")')
if [ ! -d "$DEST/node_modules/playwright-core" ] || [ "$(cat "$DEST/package.json" 2>/dev/null)" != "$PKG" ]; then
  printf '%s' "$PKG" > "$DEST/package.json"
  (cd "$DEST" && npm install --omit=dev --no-audit --no-fund --loglevel=error)
fi

cat > "$BIN" <<'LAUNCHER'
#!/bin/sh
# ui-check: scripted browser checks judged by the fast image classifier (ui-check --help).
DIR="${UI_CHECK_HOME:-$HOME/.local/share/ui-check}"
if [ -z "${OPENROUTER_API_KEY:-}" ] && [ -f "$HOME/.config/ui-check/env" ]; then
  set -a; . "$HOME/.config/ui-check/env"; set +a
fi
exec node "$DIR/ui-check.mjs" "$@"
LAUNCHER
chmod +x "$BIN"
cp SKILL.md "$SKILL_DIR/SKILL.md"

if [ -s "$ENV_FILE" ]; then KEY="key in $ENV_FILE"; else KEY="no key yet: put OPENROUTER_API_KEY=... in $ENV_FILE (see and look need it)"; fi
echo "ui-check installed: $BIN -> $DEST/ui-check.mjs; $KEY"
