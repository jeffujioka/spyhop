#!/usr/bin/env bash
# The frame check of the Live panel: runs the plugin of this folder in the Orca app on this
# computer, as the dev plugin `local.spyhop`, and stops at the first step that fails, with the
# step's answer on stderr. It validates the folder, records `orca plugin check`, loads the folder
# with `orca plugin dev watch` (stopped when the script exits), opens the panel, asks the worker
# for the fleet, shoots the panel 300 and 420 pixels wide, keeping each PNG, and reads the logs.
# `plugin check` lists no HTML panel and `plugin shot --scenario` refuses one (Orca 1.4.273), so
# the live shot of the dev plugin is the frame check and `plugin check` is only recorded.
# Usage: bash scripts/frame-check.sh [--dry-run]; --dry-run prints each `orca` command line and
# runs none. ORCA_CLI_COMMAND names the `orca` to run, as for the plugin's tests.
set -eu

ORCA=${ORCA_CLI_COMMAND:-orca}
dry=
[ "${1:-}" = --dry-run ] && dry=1
cd "$(dirname "$0")/.."

KEY=local.spyhop
SHOTS=.orca/shots
# Orca's limit on the answer a worker gives a panel's request.
MAX_ANSWER_BYTES=1048576
# A little over the panel's refresh period of 2 s.
REFRESH_WAIT=3

work=$(mktemp -d)
watch=
watched=
# The watch would run on after the script and keep the folder loaded, so the script stops it; a
# watch that was refused approval still leaves the folder listed, so the script then unloads it.
finish() {
  [ -z "$watch" ] || kill "$watch" 2>/dev/null || true
  [ -z "$watched" ] || run "$work/unload.json" plugin dev unload . --json || true
  rm -rf "$work"
}
trap finish EXIT

# Prints the command line of `orca` with the arguments after `$1`, then runs it unless this is a
# dry run, its output to the file `$1`. A failing command's output, Orca's error envelope with
# `--json`, goes to stderr too, as the file goes with the script's temporary folder.
run() {
  local out=$1 status=0
  shift
  printf '+ %s %s\n' "$ORCA" "$*"
  [ -n "$dry" ] || "$ORCA" "$@" > "$out" || status=$?
  [ "$status" = 0 ] || cat "$out" >&2
  return "$status"
}

# Whether the JSON in the file `$1`, as `a`, makes the JavaScript expression `$2` true.
holds() {
  node -e 'const a = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.exit((0, eval(process.argv[2])) ? 0 : 1)' "$1" "$2"
}

# Fails with the message `$2` and the file `$3`, unless the JSON in it, as `a`, makes `$1` true.
expect() {
  holds "$3" "$1" || { echo "frame check: $2" >&2; cat "$3" >&2; exit 1; }
}

# Whether a line of the watch's output `$1` is its event `loaded`.
loaded() {
  node -e 'process.exit(require("fs").readFileSync(process.argv[1], "utf8").split("\n").some((line) => { try { return JSON.parse(line).type === "loaded"; } catch { return false; } }) ? 0 : 1)' "$1"
}

# Records the answer `$1` of the command named `$2`, which exited with `$3`, as
# .orca/shots/frame-check-$2.json, and prints whether it drew the panel: `$4` over the answer `a`.
record() {
  mkdir -p "$SHOTS"
  cp "$1" "$SHOTS/frame-check-$2.json"
  if [ "$3" = 0 ] && holds "$1" "$4"; then drew=yes; else drew=no; fi
  echo "frame check: $2 drew the HTML panel: $drew (exit $3, $SHOTS/frame-check-$2.json)"
}

run "$work/validate.json" plugin validate . --json

status=0
run "$work/check.json" plugin check . --json || status=$?
[ -n "$dry" ] || record "$work/check.json" check "$status" 'a.result.panels.length > 0'

watched=1
printf '+ %s %s\n' "$ORCA" 'plugin dev watch . --json'
if [ -z "$dry" ]; then
  "$ORCA" plugin dev watch . --json > "$work/watch.jsonl" 2>&1 &
  watch=$!
  deadline=$((SECONDS + 60))
  until loaded "$work/watch.jsonl"; do
    if ! kill -0 "$watch" 2>/dev/null; then
      loaded "$work/watch.jsonl" && break
      watch=
      # A first load that needs approval fails with the command that approves it: the developer
      # runs it, never this script.
      if node -e 'const a = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").pop()); if (!/^approval_/.test(a.error?.code)) process.exit(1); console.log(`frame check: ${a.error.code}: ${a.error.message}\nApprove it with:\n  ${a.error.data.command}`)' "$work/watch.jsonl" 2>/dev/null; then
        exit 3
      fi
      echo 'frame check: plugin dev watch stopped before it loaded the folder' >&2
      cat "$work/watch.jsonl" >&2
      exit 1
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo 'frame check: plugin dev watch did not load the folder within 60 s' >&2
      cat "$work/watch.jsonl" >&2
      exit 1
    fi
    sleep 0.5
  done
fi

run "$work/open.txt" plugin open "$KEY" --panel spyhop

# A shot settles once the panel's page has loaded, not once the worker has answered, and no answer
# of Orca's tells what the page shows: so the worker answers the fleet first, which on a fresh
# worker means its first scan is done, and the shots wait one more refresh period for the panel's
# own request to have been answered and drawn.
run "$work/fleet.json" plugin dev request . spyhop.fleet --data '{"request":1}' --json
[ -n "$dry" ] || expect "Buffer.byteLength(JSON.stringify(a.result.result)) < $MAX_ANSWER_BYTES && Array.isArray(a.result.result.groups)" \
  "the fleet answer is not under $MAX_ANSWER_BYTES bytes with a groups array" "$work/fleet.json"
[ -n "$dry" ] || sleep "$REFRESH_WAIT"

# Each shot writes the same PNG, so each is kept as .orca/shots/frame-check-<width>[-<theme>].png,
# once the shot is known to have been taken without errors.
for width in 300 420; do
  run "$work/shot-$width.json" plugin shot "$KEY" --panel spyhop --width "$width" --json
  if [ -z "$dry" ]; then
    shot=$(node -e 'const a = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).result; console.log([a.path ?? process.argv[2], a.theme].filter(Boolean).join("\t"))' "$work/shot-$width.json" "$SHOTS/$KEY-spyhop.png")
    theme=$(printf '%s' "$shot" | cut -s -f2)
    expect 'a.result.errors.length === 0 && a.result.settled === true' "the shot $width pixels wide has errors or did not settle" "$work/shot-$width.json"
    cp "$(printf '%s' "$shot" | cut -f1)" "$SHOTS/frame-check-$width${theme:+-$theme}.png"
  fi
done

run "$work/logs.json" plugin logs "$KEY" --json
# the whole answer as text, so that a `[frame]` line is found in whichever field holds it
[ -n "$dry" ] || expect '!JSON.stringify(a).includes("[frame]")' 'the logs hold a [frame] error' "$work/logs.json"

[ -n "$dry" ] || echo 'frame check: passed'
