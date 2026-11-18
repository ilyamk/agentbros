#!/usr/bin/env bash
# Agent Bros. Pictures: first-run setup for macOS, Linux and WSL (Windows: setup.ps1).
#
#   ./setup.sh                    plan only: what is missing and the scope of each fix; changes nothing
#   ./setup.sh --apply            user-scope tools (Node through a version manager, pnpm, uv) and the
#                                 repository steps (packages, Chromium, pinned Python, .env), then a report
#   ./setup.sh --apply --system   also system packages through Homebrew or apt (FFmpeg, Chromium libraries)
#
# Other flags (--assets, --smoke, --goal <list>) pass through to `pnpm bootstrap`.
# stdout carries exactly one JSON line; progress goes to stderr. Agents: read SETUP.md first, and
# ask the user before --apply when the plan lists `user` or `system` steps.
set -u

cd "$(dirname "$0")" || exit 1
STARTED=$(date +%s)

MODE=plan
SYSTEM=0
PASS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --plan) MODE=plan ;;
    --apply) MODE=apply ;;
    --system) SYSTEM=1 ;;
    -h | --help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//' >&2
      printf '{"ok":true,"outputs":[],"metadata":{"help":true},"elapsedMs":0}\n'
      exit 0
      ;;
    *) PASS+=("$1") ;;
  esac
  shift
done

say() { printf '%s\n' "$*" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }
json_str() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  printf '"%s"' "$s"
}
elapsed_ms() { printf '%s' $((($(date +%s) - STARTED) * 1000)); }

fail_json() { # code message
  printf '{"ok":false,"error":%s,"message":%s,"elapsedMs":%s}\n' "$(json_str "$1")" "$(json_str "$2")" "$(elapsed_ms)"
  exit 1
}

[ -f package.json ] && [ -f .nvmrc ] || fail_json VALIDATION "Run setup.sh from an Agent Bros. Pictures checkout."
NODE_PIN=$(tr -d '[:space:]' <.nvmrc)
PNPM_PIN=$(sed -n 's/.*"packageManager": *"pnpm@\([0-9.]*\)".*/\1/p' package.json | head -n 1)

case "$(uname -s)" in
  Darwin) OS=macos ;;
  Linux)
    if grep -Eqs '^(ID|ID_LIKE)=.*(debian|ubuntu)' /etc/os-release; then OS=debian; else OS=linux; fi
    ;;
  MINGW* | MSYS* | CYGWIN*) fail_json VALIDATION "On Windows run setup.ps1 in PowerShell." ;;
  *) OS=linux ;;
esac

# --- probes ------------------------------------------------------------------

NVM_SH="${NVM_DIR:-$HOME/.nvm}/nvm.sh"
NODE_SCOPE=user
NODE_HINT=""
[ -x "$HOME/.local/bin/uv" ] && PATH="$HOME/.local/bin:$PATH"
export PATH

node_ok() {
  have node || return 1
  case "$(node -p 'process.versions.node' 2>/dev/null)" in
    26.* | 24.*) return 0 ;;
    *) return 1 ;;
  esac
}
pnpm_ok() { have pnpm && [ "$(pnpm --version 2>/dev/null)" = "$PNPM_PIN" ]; }
uv_ok() { have "${AGENTBROS_UV:-uv}"; }
ffmpeg_ok() { have ffmpeg && have ffprobe; }
modules_ok() { [ -f node_modules/.modules.yaml ]; }
chromium_libs_ok() {
  [ "$OS" != debian ] && return 0
  have ldconfig || return 0
  ldconfig -p 2>/dev/null | grep -q 'libnss3\.so' && ldconfig -p 2>/dev/null | grep -q 'libgbm\.so'
}

if have fnm; then
  MANAGER=fnm
  NODE_CMD="fnm install $NODE_PIN && fnm use $NODE_PIN"
  ACTIVATE="eval \"\$(fnm env --shell bash)\" && fnm use $NODE_PIN"
elif have mise; then
  MANAGER=mise
  NODE_CMD="mise install node@$NODE_PIN"
  ACTIVATE="export PATH=\"\$(mise where node@$NODE_PIN)/bin:\$PATH\""
elif [ -s "$NVM_SH" ]; then
  MANAGER=nvm
  NODE_CMD=". \"\${NVM_DIR:-\$HOME/.nvm}/nvm.sh\" && nvm install $NODE_PIN"
  ACTIVATE=". \"\${NVM_DIR:-\$HOME/.nvm}/nvm.sh\" && nvm use $NODE_PIN"
elif [ "$OS" = macos ] && have brew; then
  MANAGER=fnm-brew
  NODE_SCOPE=system
  NODE_CMD="brew install fnm && fnm install $NODE_PIN"
  ACTIVATE="eval \"\$(fnm env --shell bash)\" && fnm use $NODE_PIN"
else
  MANAGER=none
  NODE_CMD=""
  NODE_HINT="install a Node version manager (nvm: https://github.com/nvm-sh/nvm, or fnm), then rerun ./setup.sh"
  ACTIVATE=""
fi

FFMPEG_HINT=""
case "$OS" in
  macos)
    FFMPEG_CMD=""
    if have brew; then FFMPEG_CMD="brew install ffmpeg"; else FFMPEG_HINT="install Homebrew (https://brew.sh), then brew install ffmpeg"; fi
    ;;
  debian) FFMPEG_CMD="sudo apt-get install -y ffmpeg" ;;
  *)
    FFMPEG_CMD=""
    FFMPEG_HINT="install ffmpeg and ffprobe with your package manager"
    ;;
esac
CHROMIUM_LIBS_CMD="sudo apt-get install -y libnss3 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libgbm1 libasound2 libxrandr2 libxkbcommon0 libxfixes3 libxcomposite1 libxdamage1 libpango-1.0-0 libcairo2 libcups2"

# --- plan --------------------------------------------------------------------

IDS=()
SCOPES=()
REQUIRED=()
STATES=()
COMMANDS=()
HINTS=()
add_step() { # id scope required ok? command [hint]
  IDS+=("$1")
  SCOPES+=("$2")
  REQUIRED+=("$3")
  if [ "$4" = 1 ]; then
    STATES+=("done")
  elif [ -z "$5" ]; then
    STATES+=(manual)
  elif [ "$2" = repo ]; then
    STATES+=(todo)
  else
    STATES+=(needs-consent)
  fi
  COMMANDS+=("$5")
  HINTS+=("${6:-}")
}

plan() {
  IDS=()
  SCOPES=()
  REQUIRED=()
  STATES=()
  COMMANDS=()
  HINTS=()
  local ok
  ok=0; node_ok && ok=1
  add_step node "$NODE_SCOPE" true "$ok" "$NODE_CMD" "$NODE_HINT"
  ok=0; pnpm_ok && ok=1
  add_step pnpm user true "$ok" "npm install --global pnpm@$PNPM_PIN --allow-scripts=pnpm"
  ok=0; ffmpeg_ok && ok=1
  add_step ffmpeg system true "$ok" "$FFMPEG_CMD" "$FFMPEG_HINT"
  ok=0; chromium_libs_ok && ok=1
  add_step chromium-libs system true "$ok" "$CHROMIUM_LIBS_CMD"
  ok=0; uv_ok && ok=1
  add_step uv user false "$ok" "curl -LsSf https://astral.sh/uv/install.sh | env UV_NO_MODIFY_PATH=1 sh"
  ok=0; modules_ok && ok=1
  add_step install repo true "$ok" "pnpm install --frozen-lockfile"
}

steps_json() {
  local i out="" sep=""
  for i in "${!IDS[@]}"; do
    out="$out$sep{\"id\":$(json_str "${IDS[$i]}"),\"scope\":$(json_str "${SCOPES[$i]}"),\"required\":${REQUIRED[$i]},\"state\":$(json_str "${STATES[$i]}")"
    [ -n "${COMMANDS[$i]}" ] && [ "${STATES[$i]}" != "done" ] && out="$out,\"command\":$(json_str "${COMMANDS[$i]}")"
    [ -n "${HINTS[$i]}" ] && [ "${STATES[$i]}" != "done" ] && out="$out,\"hint\":$(json_str "${HINTS[$i]}")"
    out="$out}"
    sep=","
  done
  printf '[%s]' "$out"
}

consent_json() {
  local i out="" sep=""
  for i in "${!IDS[@]}"; do
    if [ "${STATES[$i]}" = needs-consent ] || [ "${STATES[$i]}" = manual ]; then
      out="$out$sep$(json_str "${IDS[$i]}")"
      sep=","
    fi
  done
  printf '[%s]' "$out"
}

print_plan() {
  local i
  say ""
  say "Agent Bros. Pictures setup ($OS): prerequisites"
  for i in "${!IDS[@]}"; do
    if [ "${STATES[$i]}" = "done" ]; then
      say "  [done] ${IDS[$i]}"
    else
      say "  [${STATES[$i]}] ${IDS[$i]} (${SCOPES[$i]})${COMMANDS[$i]:+: ${COMMANDS[$i]}}${HINTS[$i]:+: ${HINTS[$i]}}"
    fi
  done
  say ""
}

state_of() {
  local i
  for i in "${!IDS[@]}"; do [ "${IDS[$i]}" = "$1" ] && printf '%s' "${STATES[$i]}"; done
}

emit_prereq_plan() { # ok next
  printf '{"ok":%s,"outputs":[],"metadata":{"mode":%s,"stage":"prerequisites","os":%s,"nodeManager":%s,"steps":%s,"needsConsent":%s,"activate":%s,"next":%s},"elapsedMs":%s}\n' \
    "$1" "$(json_str "$MODE")" "$(json_str "$OS")" "$(json_str "$MANAGER")" "$(steps_json)" "$(consent_json)" \
    "$(json_str "$ACTIVATE")" "$(json_str "$2")" "$(elapsed_ms)"
}

handoff() { # hand over to the TypeScript bootstrap, whose JSON line becomes ours
  export AGENTBROS_SETUP_APPLIED="$APPLIED"
  [ -n "$INSTALLED_NODE" ] && export AGENTBROS_SETUP_ACTIVATE="$ACTIVATE"
  if [ "$MODE" = apply ]; then
    exec pnpm --silent bootstrap --apply ${PASS[@]+"${PASS[@]}"}
  fi
  exec pnpm --silent bootstrap ${PASS[@]+"${PASS[@]}"}
}

APPLIED=""
INSTALLED_NODE=""
plan
print_plan

if [ "$MODE" = plan ]; then
  if node_ok && pnpm_ok && modules_ok; then handoff; fi
  node_ok && ACTIVATE=""
  if [ "$(consent_json)" = "[]" ]; then
    emit_prereq_plan true "Nothing needs the user's consent: run ./setup.sh --apply now. Then follow SETUP.md."
  else
    emit_prereq_plan true "Show the user the needsConsent steps; after a yes run ./setup.sh --apply (add --system for system packages). Then follow SETUP.md."
  fi
  exit 0
fi

# --- apply -------------------------------------------------------------------

run_step() { # id command
  say "→ $1: $2"
  if bash -c "$2" >&2; then
    APPLIED="${APPLIED:+$APPLIED,}$1"
    return 0
  fi
  say "  $1 failed"
  return 1
}

activate_node() {
  case "$MANAGER" in
    fnm | fnm-brew)
      have fnm && eval "$(fnm env --shell bash)" && fnm use "$NODE_PIN" >&2
      ;;
    mise) PATH="$(mise where "node@$NODE_PIN")/bin:$PATH" ;;
    nvm)
      # shellcheck disable=SC1090
      . "$NVM_SH" && nvm use "$NODE_PIN" >&2
      ;;
  esac
  export PATH
}

if ! node_ok; then
  [ -n "$NODE_CMD" ] || fail_json VALIDATION "Node $NODE_PIN is missing and no version manager was found: $NODE_HINT."
  if [ "$NODE_SCOPE" = system ] && [ "$SYSTEM" != 1 ]; then
    fail_json VALIDATION "Installing Node needs Homebrew (a system change): ask the user, then rerun ./setup.sh --apply --system."
  fi
  if run_step node "$NODE_CMD"; then INSTALLED_NODE=1; fi
  activate_node
  node_ok || fail_json VALIDATION "Node $NODE_PIN is still not active. Install it (docs/install.md), then rerun ./setup.sh --apply."
fi
if ! pnpm_ok; then
  run_step pnpm "npm install --global pnpm@$PNPM_PIN --allow-scripts=pnpm" || true
  hash -r
  pnpm_ok || fail_json VALIDATION "pnpm $PNPM_PIN is not on PATH after installing it; see docs/install.md."
fi
if ! uv_ok; then
  if run_step uv "curl -LsSf https://astral.sh/uv/install.sh | env UV_NO_MODIFY_PATH=1 sh"; then
    PATH="$HOME/.local/bin:$PATH"
    export PATH
  fi
fi
if [ "$SYSTEM" = 1 ]; then
  if ! ffmpeg_ok && [ -n "$FFMPEG_CMD" ]; then run_step ffmpeg "$FFMPEG_CMD" || true; fi
  if ! chromium_libs_ok; then run_step chromium-libs "$CHROMIUM_LIBS_CMD" || true; fi
elif [ "$(state_of ffmpeg)" != "done" ] || [ "$(state_of chromium-libs)" != "done" ]; then
  say "System packages are left alone without --system; the report lists them."
fi
if ! modules_ok; then
  run_step install "pnpm install --frozen-lockfile" || fail_json VALIDATION "pnpm install --frozen-lockfile failed; see the output above."
fi
handoff
