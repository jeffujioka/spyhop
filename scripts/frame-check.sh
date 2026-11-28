#!/usr/bin/env bash
# The frame check of the Live panel: runs the plugin of this folder in the Orca app on this
# computer, as the dev plugin `local.spyhop`, and stops at the first step that fails, with the
# step's answer on stderr. It validates the folder, records `orca plugin check`, loads the folder
# with `orca plugin dev watch` (stopped when the script exits), restarts its worker, opens the
# panel, asks the worker
# for the fleet, then for the session of each of its cards, waits for a catch-up of the dev
# plugin's own to end on the history store, asks the worker for the Spend tab over a day and a
# year, checks every answer's
# bounds, shoots the fleet screen 300 and 420 pixels wide in Orca's dark and light themes, keeping
# each PNG, and reads the logs. The themes take effect only while Orca's window is hidden or
# minimized.
# `plugin check` lists no HTML panel and `plugin shot --scenario` refuses one (Orca 1.4.273), so
# the live shot of the dev plugin is the frame check and `plugin check` is only recorded.
# Usage: bash scripts/frame-check.sh [--dry-run]; --dry-run prints each `orca` command line and
# runs none. ORCA_CLI_COMMAND names the `orca` to run, as for the plugin's tests.
set -eu

ORCA=${ORCA_CLI_COMMAND:-orca}
dry=
[ "${1:-}" = --dry-run ] && dry=1
cd "$(dirname "$0")/.."
# The history store's checks read it with sqlite3, so a computer without it fails at once.
command -v sqlite3 > /dev/null || { echo 'frame check: sqlite3 is not installed; it reads the history store' >&2; exit 1; }

KEY=local.spyhop
SHOTS=.orca/shots
# Orca's limit on the answer a worker gives a panel's request.
MAX_ANSWER_BYTES=1048576
# The most points a series of a session answer holds (SERIES_POINTS, spec D45).
SERIES_POINTS=120
# The refreshes within which every sub-agent of a session is read, at 16 a refresh.
READ_REFRESHES=30
# A little over the panel's refresh period of 2 s.
REFRESH_WAIT=3
# The history store the worker's catch-ups fill (src/history/store.ts).
STORE=$HOME/.local/state/spyhop/insights.db
# The most a catch-up of a store already filled takes, in seconds: the meta `catch-ups` grows once
# every Orca host has been read.
CATCH_UP_WAIT=300
# The most a first catch-up takes, which reads every Orca host whole: 16.5 minutes on the Mac this
# was built on (README, Refresh).
FIRST_CATCH_UP_WAIT=1800

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

# The catch-ups the history store counts in its meta `catch-ups` before the dev plugin is loaded,
# 0 while it counts none: the check waits for one more, the dev plugin's own, for CATCH_UP_WAIT,
# or FIRST_CATCH_UP_WAIT while the store is missing. `sqlite3 -readonly` cannot open a store in
# WAL mode that no worker holds, which has no `-shm` file, so its count is then read from the file
# alone (`immutable=1`), where a worker that closed the store left every change.
count="SELECT value FROM meta WHERE key = 'catch-ups'"
catch_ups() {
  sqlite3 -readonly "$STORE" "$count" 2>/dev/null || sqlite3 -readonly "file:$STORE?immutable=1" "$count" 2>/dev/null
}
printf '+ %s\n' "sqlite3 -readonly $STORE \"$count\""
before=
wait=$CATCH_UP_WAIT
if [ -n "$dry" ]; then
  :
elif [ ! -e "$STORE" ]; then
  wait=$FIRST_CATCH_UP_WAIT
  echo "frame check: no history store yet; waiting up to $FIRST_CATCH_UP_WAIT s for the first catch-up, which reads every Orca host"
elif before=$(catch_ups); then
  echo "frame check: the history store counts ${before:-0} catch-ups; waiting for one more"
else
  echo "frame check: cannot read the catch-ups of the history store $STORE" >&2
  exit 1
fi
before=${before:-0}

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

# A watch of a folder that is already loaded, as after `orca plugin dev load .`, keeps its worker
# running, which then starts no catch-up for up to 15 minutes: the worker is stopped, so that the
# next request starts it fresh, with a catch-up of its own.
run "$work/restart.json" plugin restart "$KEY" --json

run "$work/open.txt" plugin open "$KEY" --panel spyhop

# A shot settles once the panel's page has loaded, not once the worker has answered, and no answer
# of Orca's tells what the page shows: so the worker answers the fleet first, which on a fresh
# worker means its first scan is done, and the shots wait one more refresh period for the panel's
# own request to have been answered and drawn.
run "$work/fleet.json" plugin dev request . spyhop.fleet --data '{"request":1}' --json
[ -n "$dry" ] || expect "Buffer.byteLength(JSON.stringify(a.result.result)) < $MAX_ANSWER_BYTES && Array.isArray(a.result.result.groups) && typeof a.result.result.burn === 'object' && a.result.result.burn !== null && Array.isArray(a.result.result.attention)" \
  "the fleet answer is not under $MAX_ANSWER_BYTES bytes with groups, burn and attention" "$work/fleet.json"

# The session of every card of the fleet, each request one refresh of the worker: each answer is
# under Orca's limit with series of at most SERIES_POINTS points, and the card's `reading` is null
# once its sub-agents are all read. A card's id joins its parts with NUL characters, which no shell
# variable holds, so each id goes through the script as its JSON text, one a line. A dry run has
# no fleet answer and lists one card, `<id>`.
if [ -n "$dry" ]; then
  cards='"<id>"'
else
  cards=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).result.result.groups.flatMap((group) => group.cards.map((card) => JSON.stringify(card.id))).join("\n"))' "$work/fleet.json")
  [ -n "$cards" ] || echo 'frame check: the fleet answer lists no card, so no session answer is checked'
fi
# The ids come on descriptor 3, as `orca` reads the standard input.
while IFS= read -r card <&3; do
  [ -n "$card" ] || continue
  data=$(node -e 'console.log(JSON.stringify({ request: 2, card: JSON.parse(process.argv[1]) }))' "$card")
  refresh=1
  while :; do
    run "$work/session.json" plugin dev request . spyhop.session --data "$data" --json
    [ -z "$dry" ] || break
    # The worker answers `session: null` once Orca no longer lists the card's agent: a card that
    # left during the check is passed over, and only one the fleet still lists fails.
    if holds "$work/session.json" 'a.result.result.session === null'; then
      run "$work/listed.json" plugin dev request . spyhop.fleet --data '{"request":3}' --json
      if holds "$work/listed.json" "a.result.result.groups.some((group) => group.cards.some((card) => card.id === ($data).card))"; then
        echo "frame check: the session answer of $card is null while the fleet still lists it" >&2
        cat "$work/session.json" >&2
        exit 1
      fi
      echo "frame check: $card left Orca during the check; its session is not checked"
      break
    fi
    expect "const s = a.result.result.session; Buffer.byteLength(JSON.stringify(a.result.result)) < $MAX_ANSWER_BYTES && [s.tokens?.points, s.context?.points, s.cost?.own, s.cost?.sub].every((series) => !Array.isArray(series) || series.length <= $SERIES_POINTS)" \
      "the session answer of $card is not under $MAX_ANSWER_BYTES bytes with series of at most $SERIES_POINTS points" "$work/session.json"
    holds "$work/session.json" 'a.result.result.session.card.reading === null' && break
    if [ "$refresh" -ge "$READ_REFRESHES" ]; then
      echo "frame check: the sub-agents of $card are not all read within $READ_REFRESHES refreshes" >&2
      cat "$work/session.json" >&2
      exit 1
    fi
    refresh=$((refresh + 1))
  done
done 3<<EOF
$cards
EOF

# The history store and the Spend tab: once a catch-up of the dev plugin has ended, as the store
# counts one more than before it was loaded, the Spend tab over a day and over a year is under
# Orca's limit with a cost that is a number or `n/a`, and the store is not empty.
printf '+ %s\n' "sqlite3 -readonly $STORE \"$count\""
if [ -z "$dry" ]; then
  deadline=$((SECONDS + wait))
  # sqlite3 fails while the store is missing or locked, and prints nothing before a catch-up ends
  until [ "$(catch_ups || true)" -gt "$before" ] 2>/dev/null; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      # a store that sqlite3 cannot open either is one the worker could not make or open
      if ! catch_ups > /dev/null; then
        echo "frame check: cannot open the history store $STORE" >&2
      else
        echo "frame check: no catch-up of the history store $STORE ended within $wait s" >&2
      fi
      exit 1
    fi
    sleep 1
  done
fi
for range in day year; do
  run "$work/range.json" plugin dev request . spyhop.range --data "{\"request\":3,\"tab\":\"spend\",\"range\":\"$range\"}" --json
  [ -n "$dry" ] || expect "Buffer.byteLength(JSON.stringify(a.result.result)) < $MAX_ANSWER_BYTES && (typeof a.result.result.spend.cost === 'number' || a.result.result.spend.cost === 'n/a')" \
    "the Spend answer over a $range is not under $MAX_ANSWER_BYTES bytes with a cost that is a number or n/a" "$work/range.json"
done
printf '+ test -s %s\n' "$STORE"
[ -n "$dry" ] || test -s "$STORE" || { echo "frame check: the history store $STORE is missing or empty" >&2; exit 1; }

# A panel opened while Orca's window is hidden asks the worker for nothing, as the page is hidden
# (src/live/controller.ts), and a shot settles once the page has loaded, not drawn: so one shot,
# not kept, shows the panel, which then asks for its screen, drawn a refresh period later.
run "$work/shot.json" plugin shot "$KEY" --panel spyhop --width 300 --json
[ -n "$dry" ] || expect 'a.result.errors.length === 0 && a.result.settled === true' "the shot that shows the panel has errors or did not settle" "$work/shot.json"
[ -n "$dry" ] || sleep "$REFRESH_WAIT"

# Each shot writes the same PNG, so each is kept as .orca/shots/frame-check-<width>-<theme>.png,
# once the shot is known to have been taken without errors and in the theme asked for.
for width in 300 420; do
  for theme in dark light; do
    run "$work/shot.json" plugin shot "$KEY" --panel spyhop --width "$width" --theme "$theme" --json
    if [ -z "$dry" ]; then
      expect 'a.result.errors.length === 0 && a.result.settled === true' \
        "the shot $width pixels wide in the $theme theme has errors or did not settle" "$work/shot.json"
      # Orca paints a theme only while its window is hidden or minimized (`orca plugin shot --help`).
      if ! holds "$work/shot.json" 'a.result.themeApplied === true'; then
        echo "frame check: the shot $width pixels wide is not in the $theme theme" >&2
        echo "frame check: hide or minimize Orca's window, then run the check again" >&2
        cat "$work/shot.json" >&2
        exit 1
      fi
      cp "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).result.path ?? process.argv[2])' "$work/shot.json" "$SHOTS/$KEY-spyhop.png")" \
        "$SHOTS/frame-check-$width-$theme.png"
    fi
  done
done

run "$work/logs.json" plugin logs "$KEY" --json
# the whole answer as text, so that a `[frame]` line is found in whichever field holds it
[ -n "$dry" ] || expect '!JSON.stringify(a).includes("[frame]")' 'the logs hold a [frame] error' "$work/logs.json"
[ -n "$dry" ] || expect '!JSON.stringify(a).includes("node:sqlite")' 'the logs hold a node:sqlite error' "$work/logs.json"
# a file of this computer, which each such line names (src/history/catch-up.ts), under its home;
# another host that cannot be asked or reached is logged too, and is not this check's
[ -n "$dry" ] || expect '!a.result.lines.some(({ line }) => /^spyhop: catch-up cannot (read|list) /.test(line) && line.includes(`${process.env.HOME}/`))' 'the logs hold a catch-up that cannot read a file of this computer' "$work/logs.json"

[ -n "$dry" ] || echo 'frame check: passed'
