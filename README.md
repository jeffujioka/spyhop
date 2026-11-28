# spyhop

An Orca plugin that shows AI harness session stats for every Orca agent, on this computer and
on Orca's other hosts, in a panel of the right sidebar.

It is derived from [herdr-session-stats](https://github.com/jeffujioka/herdr-session-stats), a
herdr mod; the session readers in `src/core/` are copied from it, while `src/core/limit.js`,
`src/core/series.js` and `src/core/ttl-cache.js` are spyhop's own.

## What the panel shows

The panel is an HTML panel drawn in Orca's own theme, light or dark, which follows a change of
theme without being loaded again. Its tab bar holds four tabs, Live, Spend, Cache and Health, in
that order, and the panel opens on Live. Spend, Cache and Health are the range tabs: under the
tabs they show one range control, Day, Week, Month and Year, set to Day when the panel opens and
shared by the three, so that a range pressed on one holds on the others; Live shows no range
control. Spend is described under Spend tab; Cache and Health show only the tab bar and the range
control for now. Live opens on the fleet screen:

- **The header**: `Spyhop`, a `live` mark, and the number of agents in each Orca state
  (blocked, waiting, working, done) that any agent is in. The counts are drawn once a whole
  refresh is answered, never from part of one.
- **The burn rate card**, drawn once a whole refresh is answered: the burn rate, the cost the
  shown sessions and their sub-agents logged in the last 10 minutes as cost per hour, and beside
  it `all sessions`, the whole cost of the shown sessions with their sub-agents (there is no
  figure per day). Its chart draws the burn rate at each of the last 60 minutes, stacked by
  session: the three sessions of the highest cost over that hour by title, each with its rate,
  and every other one as `others`, with times of day under it (see Chart axes). Under it are
  the tokens per minute of the last 10 minutes, the cache hit rate of the last 60 and how many
  sub-agents run now. Only omp and opencode log a cost per model call, so only their sessions
  count in the rate and its chart; while a Claude Code session is shown, the card says how many
  sessions the rate leaves out. Every sum reads
  `n/a` while a session it counts has a sub-agent transcript not read yet, and `all sessions`
  too while a shown session's cost cannot be read. An agent that links to no session counts in
  no sum.
- **The attention list**, drawn once a whole refresh is answered, and not at all when it has no
  row: first a row for each agent blocked or waiting, with how long it has been so, the longest
  first; then a row for each session at 75% of its window or more (the percent from which the
  card's chip tells the tokens left), with its percent and, when known, the tokens left before
  the harness compacts on its own, the one longest at 75% or more first; then a row for each agent
  not working whose session's prompt cache goes cold within 2 minutes, with the time left,
  counted down at each refresh, and the context tokens the next model call would write to it
  again, the soonest first. The time left is counted from the cache's lifetime the call logged:
  omp's `cttl` (`ephemeral5m` 5 minutes, `ephemeral1h` one hour) and Claude Code's
  `cache_creation` split. opencode's sessions get no cache row: their cache countdown cannot
  be read. Each row names its session by its title.
- **A group per Orca host**, this computer's (`local`) first, then the others in the order Orca
  lists their first agent, each with the number of its cards. There are no project or workspace
  rows. A group's cards go by Orca state: blocked, waiting, working, done.
- **A card per session** whose agent is not done (agents on one session share a card, and an
  agent that links to no session has a card of its own): the session's title (the folder's name
  for an untitled one), its cost (see Costs) with its
  sub-agents' (see Sub-agents in the cost) and its burn rate over the last 10 minutes (`n/a` for
  Claude Code, and while its sub-agents are being read), the folder,
  git branch, harness and model, the agent's state and how long it has been in it, and its
  context: the percent of the model's window used, the tokens used and the window, a bar marking
  where the harness compacts on its own, and a spark line of the context after each of the last
  30 model calls. Its chips tell, from 75% of the window, the tokens left before compaction;
  how many of its sub-agents run and how many there are (for Claude Code and opencode, which do
  not tell which run, how many there are), none without a sub-agent; and its cache hit rate.
- **A done agent's session on one folded line**: its title, folder, context and cost.

Pressing a card, a folded line or a row of the attention list, by a click or by Enter or Space
once it has the keyboard's focus, opens that session's screen at once, with its header from the
card, and its back control
shows the fleet screen again. When Orca no longer lists the agent of the open session screen, the
next refresh shows the fleet screen. A screen that opens starts at its top; a refresh keeps the
place it is scrolled to.

The folder is the one the linked session records as its own, which can be a sub-folder of the
Orca workspace folder, and the branch is that folder's: for omp the folder of the session's
`session` entry, for Claude Code the folder the session started in (the first `cwd` in its
file), for opencode the session's `directory`. A card with no linked session, of another
harness, or whose session tells no folder shows the workspace folder and its branch.

A figure the session does not give reads `n/a`; the plugin never estimates one. A context with
no known window shows its tokens, with no percent and no bar.

### Sub-agents in the cost

A session's cost and tokens hold those of its sub-agents, sub-agents of sub-agents included,
once every sub-agent transcript of the session is read. Until then the card and the session
screen show the session's own figure with `reading <n> of <m> sub-agents`, and a done session's
folded line shows `reading <n>/<m>` and no cost, never a partial sum.
Claude Code's cost is the total it logs for the session, which holds its sub-agents' already, so
nothing is added to it, and its split into own and sub-agents reads `n/a`; its tokens are
summed like the other harnesses'. The model calls and the tool calls are the session's own.

### Costs

A session's cost is what the harness logged, but for model calls through GitHub Copilot
(provider `github-copilot`), in omp or opencode: Copilot bills tokens, so such a call costs its
tokens at the Copilot price table's prices, in AI credits at 0.01 USD a credit: those sent not
cached, read from the cache, written to it and output, each at the model's price, and at a
long-context tier's prices when the prompt passes that tier's threshold. The table is
`src/core/copilot-prices.js`, copied from GitHub's
[models and pricing page](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing)
as read on 2026-11-28, and updated by hand. A Copilot call on a model the table does not hold
costs `n/a`, and so does every total that counts it; a Copilot call that spent no token (one
aborted, or that failed before the model answered) costs 0. An opencode session with a Copilot
call costs the sum of its calls, not opencode's own total. Claude Code logs no provider, so none
of its calls is a Copilot call.

omp's side calls, its `model_usage` entries (a title, a recap, a prediction of the next prompt),
count in their session's cost and tokens, its cost chart's own layer and the burn rate, as the
main agent's. They are no model call: not in the model calls, the tokens per model call chart,
the cold starts or the cache figures. The Models section names them among what used a model, as
`side calls`.

## Session screen

A session's screen has a header with the back control, the agent's state, the title, the
harness, model, folder and how long the agent has been in its state, and a Focus button when
the agent has a pane (see Focus pane). Under it:

- **Four figures**: the cost, with the share its sub-agents spent; the tokens, with the share
  read from the prompt cache; the model calls, with the tool calls that failed; and how long
  the session has run, with the day it started.
- **Three charts** over the whole session, each with at most as many points as it has room for
  (neighbouring model calls summed):
  - the context after each model call, as a percent of the window coloured by level, with its
    peak, its compactions and the tokens left before the harness compacts on its own, or in
    tokens when the window is not known;
  - the tokens of each model call: read from the cache, written to it, not cached, and the
    output, with the session's cache hit rate and a note of its cold starts. A cold start is a
    model call after the first that read nothing from the prompt cache, so it wrote the prompt
    to the cache again; the note gives how many, the tokens written again and their cost;
  - the cost over time, of the session's own model calls and side calls and of its sub-agents,
    with the total and the cost per hour over the session's duration. When part of the total is
    from Copilot calls, the card splits it into the part `from tokens at GitHub prices` and the
    rest as the harness logged it; when the harness logged part of the cost without a model
    call, as opencode can, the card says how much.
- **Sub-agents**, for a session with any: how many run (not for Claude Code or opencode, which
  do not tell), how many there are and their cost; a row for each running one, with its kind, name,
  task, how long it has run and its cost; and on one time axis a bar for each of the 8 that
  started last, in the order they started, from the time of its transcript's first entry to its
  last, coloured by its kind, under its name, kind, model and cost. With more, the section says
  how many started earlier and offers `Show all`, which draws a bar of each until the screen
  changes.
- **Tools**: the six tools called most, the rest summed as `others`, each with its failures.
- **Models**: the cost by model, each with what used it: the main agent, the sub-agents, omp's
  side calls. Claude Code's is the cost by model its newest `cost-state` gives, under the names it
  gives them (such as `claude-opus-5-5[1m]`), sub-agents included.
- **Session**: when it started, the thinking level, the time to the last reply, the premium
  requests, and the branch, remote and Orca host where there is one.

A model call is a call that logged usage. An omp call that logged none, or a usage of all zeros
(one omp aborted, or that failed before the model answered), is not counted: not in the model
calls, the charts or the cold starts. A part with nothing to show, such as the charts of a
session without a model call, is not drawn.

### Chart axes

The burn rate chart and the session screen's context, tokens and cost charts each have faint
lines at zero, one step and two steps of a round scale, the step the smallest of 1, 2 or 5 × 10ⁿ
whose double reaches the chart's highest value; the values of the lines at one and two steps are
written inside the chart at its left. A context chart with a window keeps its scale to at least
100%, and the tokens chart's lines are of its prompt tokens (its output tokens have a scale of
their own, with no lines). Under the burn rate, context and cost charts are at most five times
of day at round marks, at the smallest step of 1, 2, 5, 10, 15 or 30 minutes, 1, 2, 3, 6 or 12
hours, or whole days, that keeps them to five; a span with no such mark gets its first and last
times. Under the tokens chart, whose bars are spaced per model call, at most five bars are
marked, the first and every n-th one after it, each with the time of its last call.

### Chart hover

While the pointer is over one of those four charts, a line crosses the chart at the point
nearest the pointer, with a dot on each layer there, and a box at the top of the chart, in the
half the line is not in, gives the point's values; the chart's key and headline stay as they
are, and the line and the box go when the pointer leaves the chart. The burn rate chart's box
gives the minute, the total cost per hour and each layer's; the context chart's the time, the
percent when there is a window, the tokens and the compactions since the point before, each
with its tokens before and after, the newest two and how many more; the tokens chart's the
call's time, or for a bar of several calls how many and their span (`4 calls between 12:01 and
12:09`, the first bar's `4 calls up to 12:09`), and the tokens read from the cache, written to
it, not cached and output; the cost chart's the time, the session's own cost, its sub-agents'
and their total. A value that cannot be read reads n/a. A box stays within its chart from the
panel's narrowest, 300 px: the burn rate box cuts a name over 12 characters short with `…`, the
key keeping it whole.

Each of the four charts is one stop of the Tab key, named by its title. A chart that takes the
keyboard's focus shows its line and box on its newest point; Left and Right move them one point,
Home and End to the first and the last point, and Escape hides them until the next of those
keys, which moves from the point they were on. They go when the focus leaves the chart.

A refresh keeps the line and the box, of a hovered or a focused chart, on the point of the same
time, or on the first point after it when that time is no longer a point, with the values the
refresh gives it; a focused chart keeps the focus.

## Spend tab

The Spend tab is a range tab: Day, Week, Month or Year. It reads the history store (see What
spyhop stores) and shows:

- **Reading history: `<host>, <harness>, <n>%`**, while a catch-up reads an Orca host's harness
  that was never read through, such as on the first catch-up: the host, the harness and the share
  of its bytes (opencode: its model calls) read so far.
- **What the range cost**, of every harness session in the history store, sub-agents included;
  when part of it is from Copilot calls, the part `from tokens at GitHub prices` and the rest as
  the harnesses logged it (see Costs). Beside it, the range's tokens and model calls.
- **Side calls**: what omp's side calls cost of the range's cost.
- **Cost over time**, for Week, Month and Year: what each day cost, or each month for Year.
- **By repo, By model, By harness**: the range's cost by each, costliest first, the six
  costliest named and the rest summed as `others`. A model is named with its provider where the
  harness logs one (omp, opencode); Claude Code's models are named without the provider prefix,
  context size or date its names can carry, so `claude-opus-5-5[1m]` and
  `claude-haiku-4-5-20251001` count as `claude-opus-5-5` and `claude-haiku-4-5`.

## Harnesses

Cards read the harnesses' own session files, read-only: omp, Claude Code and opencode (its
database, whose Orca agents are of the kind `opencode` or `opencode2`: a session is read from its
current tables, and from its legacy ones only when the current ones do not hold it). An
opencode session's window is the `limit.context` opencode's own model catalogue,
`~/.cache/opencode/models.json` on the session's host, holds for its provider and model, read
again at most once an hour; without the catalogue or the model in it the window is not known. An
agent of any other harness gets a card whose figures all read `n/a`.

## How an agent is tied to a session

- **By session id**: when Orca reports the agent's `sessionId`, the card links to the session of
  that id, by the harness's own naming, in whichever folder of the agent's host the harness ran,
  so also the session of a harness that runs in a sub-folder of the workspace folder: for omp
  the session file `<start time>_<id>.jsonl` in any of omp's session folders; for Claude Code
  the file `<id>.jsonl` in any session folder under `~/.claude/projects`; for opencode the
  database's session of that id, whatever its folder. Agents on a paired Orca server have no
  `sessionId` (Orca's listing there gives only its own id), so they link as below.
- **Otherwise** (no `sessionId`, or one that names no session), by the harness's rule:
  - **omp, by title.** The card links to the omp session whose title the agent's own title
    contains, the longest title first, one agent per session, among the sessions whose recorded
    folder is the workspace folder or a folder below it. So an omp that runs in a sub-folder of
    the workspace folder is found too, while a session of a folder beside it whose name merely
    starts alike (`projects-old` beside `projects`) is not taken. An agent whose title contains
    no session's title links to none: every session figure on its card reads `n/a`, and it
    never takes another session by its age. An agent a paired Orca server lists without a title
    takes the title of the terminal of its pane, as that server lists it.
  - **Claude Code and opencode, the newest.** They write no title into their sessions, so the
    card links to the newest session of the workspace folder itself that no id names, never
    one of a sub-folder; agents left on one session share its card. A folder with no session
    is not linked, and every session figure on its card reads `n/a`.

## Other hosts

An agent on an SSH workspace, and an agent on a paired Orca server, get cards too, under their
own host's group. Their session files and git facts are read over `ssh <alias> -o BatchMode=yes -o
ConnectTimeout=5`, at most eight commands at once on a host whose SSH connection spyhop keeps
for itself and four on any other (one whose own SSH settings already reuse connections, or
whose settings cannot be read), with read-only commands only: `cd`,
`uname -s`, `printenv HOME`, `cat`, `head`, `tail`, `dd` (reading a block, never writing one),
`find` with `stat`, a bare `stat`, `git branch --show-current`, `git remote get-url`, `sqlite3
-readonly` and `zstd -V`; the history catch-up also runs `find`, `dd`, `tail` and `sqlite3
-readonly` within `sh -c`, which pipes their output through `zstd -q -c` and keeps their exit code.
The hosts and the paired servers' agents are listed with the `orca` CLI on every refresh while
the panel is open: every paired server `orca environment list` lists gets its agents from `orca
agent list --environment <name>`, since Orca lists no paired server's workspace to a plugin, and
the terminals of their panes from `orca terminal list --environment <name>`; `orca host list` and
`orca environment list` are asked again once a minute. A paired server that cannot be listed, or
answers anything but its agents, shows none, and every other host is still drawn. The plugin is
installed on the Mac only; nothing is installed on the other hosts.

The plugin makes the commands on one host share one SSH connection, unless the alias's own
settings already do or `ssh -G` fails. For each alias, it reads `ssh -G <alias>` on the Mac, at
most once a minute. When its `controlmaster` is already `auto`, `yes`, `ask` or `autoask`, the
alias's own settings decide, and the plugin adds nothing. Otherwise, `ControlMaster no`
included, it adds `-o ControlMaster=auto -o ControlPath=/tmp/spyhop-<uid>/%C -o
ControlPersist=60`: the control socket lives on the Mac only, in a folder open to your user
alone (mode 700), and the connection closes a minute after its last command. When `ssh -G`
fails, or `/tmp/spyhop-<uid>` is a symlink or another user's folder, the plugin adds nothing.

## Refresh

While the panel is open it asks the worker for what its screen shows, the fleet or the open
session every 2 seconds, a range tab over its range every 60 seconds: each request starts that
long after the previous one started, or as soon as that one is answered when it took longer, and
never while another is unanswered. While
it is closed or hidden it asks for nothing: a refresh that was running when it closed runs to its
end, and no other starts. A refresh that fails leaves the screen as it was, and the next one
draws it again. Opening a session's screen, going back to the fleet, or pressing another tab or
range asks at once, or as soon as the request out is answered. The worker answers a range tab
after a catch-up (below) of its own when no catch-up runs and the last one started 58 seconds
ago or more, so that each 60-second refresh of a shown range tab reads what the harnesses logged
since the one before.

During a refresh each host's group appears as soon as that host's cards are built, without
waiting for another host: this computer's are not held up by a slow SSH host or paired server.
When the refresh ends its whole answer replaces what is drawn, so the group of a host that is
gone disappears then, and the header's counts are drawn from it. A group built for an older
refresh is never drawn.

Apart from the panel, the worker runs a catch-up when it starts and every 15 minutes after,
whether the panel is open or closed, and between catch-ups reads nothing for them. A catch-up
reads this computer and every Orca host Orca lists, each SSH host and each paired Orca server (a
paired server deployed over a listed SSH target shares that target's home, so it is read once,
as the SSH host), another host over ssh (see Other hosts). On each it lists the omp and Claude
Code session files and sub-agent transcripts with one `find` for each, and reads each one into
the history store (see What spyhop stores) from where its last
read ended, one program at a time: a file whose size and modified time are those of its last read
is not read, and a file shorter than that read, or no longer the file that was read, is read again
from its start and its counts replace those it gave before. A file that cannot be read is written
to the worker's log and tried again at the next catch-up; a catch-up that cannot list a sessions
folder is written to the log too, reads nothing of that harness and is tried again at the next
one. It then reads that host's opencode database (`~/.local/share/opencode/opencode.db`, with
`sqlite3 -readonly`): the first time every model call in it, 5,000 rows a query, and at each later
catch-up again the calls created in the last 10 days, whose counts replace those read before, as
opencode can update a call in place. A day older than that keeps the counts it was read with. A
call counts on the day it was created, in its root session (its sub-agents' calls included), and
in the repo of its own session's folder, as git gives it when the folder is first read, kept
after. A database there that cannot be read, `sqlite3` missing included, is written to the
worker's log and tried again at the next catch-up.

A catch-up reads in two phases: first, on every Orca host at once, the files and opencode calls
of the last 30 days, then the older ones, each phase's files newest first, so that a first
catch-up of a long history shows the recent days soon.

On the Mac it was built on (2026-11-28), with about 1 GB of omp and 34 MB of Claude Code
session files and a 2 GB opencode database, and Orca hosts of 2.8 GB and 27 MB of omp files,
the first catch-up took 16.5 minutes with the panel open, this Mac's own files read in the first
5 of them, and left a history store of 123 MB. Orca listed this Mac again as `localhost` and
`127.0.0.1`, and each other host under two aliases, and each alias was read as a host of its
own. A later catch-up of the same files took about 15 seconds.

## What spyhop stores

Session totals, in the plugin's own storage on this computer (`storage:own`), and the history
store (below); the panel's
page keeps nothing of its own, and shows only what the worker answers. For each session file,
and each omp or Claude Code sub-agent transcript, larger than the 256 KiB a refresh reads from
its end, the totals the session reader counted over the file, the context sizes of its last 30
model calls, the tokens, cost and context of all its model calls in at most 120 points
(neighbouring calls summed once there are more), its compactions with their tokens before and
after, its cold starts, its tool calls and failures by tool name, the ids of its tool calls not
answered yet (with their tool's name, so that a later answer counts its failure), its cost and
tokens by model name, the agent kind and model a sub-agent's transcript records and whether its
turn is open, the time of a session file's `session` entry, the times of its first and last
entry, and the position they cover, by harness, machine and path. No session text is stored,
and nothing is written on any other host. They are there so that a file scanned once is not
scanned again from its start after Orca restarts: the reader goes on from the kept position,
and scans the file again when it is not the one that was scanned. They are written at most once
every 30 seconds, and only when a scan changed. Orca keeps no stored value over 256 KiB and no
storage over 5 MiB, so they are stored as JSON texts split over the keys `session-totals`,
`session-totals.1` and on, each under 256 KiB and all together at most 4 MiB; a later write that
needs fewer keys removes the ones left over. A write keeps the totals of every file kept before,
read since Orca started or not, so a session no agent shows now keeps its totals. Past 4 MiB,
files are left out in this order until the rest fit: the transcripts of ended omp sub-agents, the
one read longest ago first, then the other files, the one read longest ago first, by when each
was last read in any run; a file whose totals alone would not fit in a key is left out too. A file
left out is scanned again whole after a restart. They are stored as version
6: the first open after an update from a spyhop that stored another version (spyhop 0.2.0 stored
version 5, whose totals hold no side calls or Copilot prices), or stored them in another form,
scans each file once from its start, which is all that deleting the storage costs too.

The history store is the SQLite file `~/.local/state/spyhop/insights.db` on this computer, made
when missing, which the catch-ups fill and nothing deletes, so it keeps what they read after omp
or Claude Code deletes its files. For each session file it holds the daily lines of its model
calls and omp's side calls that log their model: their count (model calls only), tokens and cost
summed by the day each call ended, the session, the repo and the model, with the side calls'
cost and tokens and the Copilot calls' cost apart, and how far the file was read with the
session reader's state there. Claude Code logs no cost of a call, so its calls count at no cost,
and each `cost-state` it logs adds to a model's cost what it gives that model less what the
session's previous one gave it. A `cost-state` has no time of its own, so it counts on the day of
the entry before it: one written just after midnight counts on the day before. One that gives a
model less than the previous one did starts the session's cost again (a restarted session), so
its costs are added whole and no day is negative; one before any dated entry counts with the
next one. Claude Code's calls and costs are filed under one name per model, without the
`anthropic.` prefix, the `[1m]` context size or the date its names can carry. A file's repo is
set when it is first read: the git origin of the folder
it records first (omp: its `session` entry), else that folder, else `n/a`; a sub-agent's
transcript counts in its own folder's repo and in its main session. Another Orca host's lines are
kept by the ssh alias it is read over, not by Orca's id of it, so a target removed and added again
in Orca is counted once. Another program that holds the store, such as `sqlite3`, is waited for up
to 5 seconds.
A store that cannot be opened, or a Node in Orca that cannot load `node:sqlite`, is written to
the worker's log once; the range tabs then read n/a, and Live is drawn as ever.

## Focus pane

The session screen of an Orca agent that has a pane shows a Focus button; an agent in a chat with
no terminal, or a server agent whose pane no listed terminal holds, has none. Pressing it focuses
the agent's pane in this computer's Orca window, showing its workspace, as clicking the pane
does; a session that agents share focuses the first of them in Orca's order. For an agent on this
computer or an SSH workspace it asks Orca through `terminal.focus`; for one on a paired Orca
server it runs `orca terminal switch --environment <name> --terminal <handle>`, the handle
`orca terminal list` gave for the pane. Neither writes anything on any host or runs anything
over ssh. A focus that fails changes nothing in the panel and writes the reason to the plugin's
log (`orca plugin logs`). Orca's desktop app only.

## Command and key

The palette command `Spyhop: Show session stats`, bound to `Mod+Alt+Shift+S` (Cmd on macOS,
Ctrl elsewhere), shows the panel in the right sidebar. Orca gives a plugin no call that shows its
own panel, so the command does it through the Orca CLI: it finds the plugin's key with `orca
plugin list` (the spyhop install that is not disabled, when a Git and a folder install are both
listed) and runs `orca plugin open <key> --panel spyhop`.

## Install, develop, test

- Install from Git: `orca plugin install https://github.com/jeffujioka/spyhop`, or from a clean
  clone with no `node_modules` folder: `orca plugin install <dir>`. Orca may refuse a folder
  that holds `node_modules`, over the `node_modules/.bin/tsc` symlink `npm install` writes.
  spyhop runs code in a worker, so Orca asks for approval (`approval_required`) and prints the
  command to re-run with `--approve <fingerprint>`. It needs Orca 1.4.259 or newer, and is
  granted four capabilities: `workspace:read` and `agent:read` to list the workspaces and
  agents, `workspace:write` for focusing an agent's pane only (`terminal.focus`, no other
  method of it), and `storage:own` for the session totals it keeps (see What spyhop stores).
  An installed spyhop without `workspace:write` or `storage:own` asks for approval again when
  updated.
- Develop: `orca plugin dev watch .` loads the folder and reloads on each save;
  `orca plugin types .` writes the typings into `.orca/types/` (`npm run typecheck` also runs
  `tsc`).
- Test: `orca plugin test . --json` (`npm test`) runs the tests with Node's test runner and
  Orca's test kit; `orca plugin validate . --json` checks the manifest as Orca loads it.
- Frame check: `bash scripts/frame-check.sh` runs the folder in the Orca app on this computer
  as the dev plugin `local.spyhop`. It needs `sqlite3`, and fails at once without it. It counts
  the history store's catch-ups (its meta `catch-ups`, with `sqlite3 -readonly`), loads the
  folder with `orca plugin dev watch` and restarts its worker (`orca plugin restart`: a watch of
  a folder already loaded keeps the old worker, which starts no catch-up for up to 15 minutes),
  opens the Live panel, asks the worker for the fleet and then
  for the session of each of its cards with `orca plugin dev request` (each answer under 1 MiB,
  each series at most 120 points, every card's sub-agents read within 30 refreshes), waits up
  to 300 seconds for the restarted worker's own catch-up to end, asks it for the Spend tab over
  a day and a year (each answer under 1 MiB, its cost a number or `n/a`) and checks that the
  store is not empty, then
  shoots the fleet screen 300 and 420 pixels wide in Orca's dark and light themes on this
  computer's own agents (the PNGs go to `.orca/shots/`; a theme takes effect only while Orca's
  window is hidden or minimized) and fails on a `[frame]` error, a `node:sqlite` error or a
  catch-up that cannot read or list a file of this computer in
  `orca plugin logs`; it unloads the folder when it exits. `orca plugin check` lists no HTML
  panel, `orca plugin shot --scenario` refuses one and `orca plugin shot --act` presses only in
  a components panel, so the panel has no check scenarios and no shot of a tab other than Live:
  the session screen and the Spend tab are checked by eye. Orca asks for the dev plugin's
  approval again after every change to a file of the folder, and the check prints the command
  that gives it.
- Page tests: `npm run test:page` runs the `test/page/**/*.page.ts` tests with Node's test runner
  (`npm test` does not): they compile the panel's page with the project's TypeScript, with no
  bundler, load it in headless Chrome, the Google Chrome installed in `/Applications` (Playwright
  downloads no browser), with a stand-in for Orca that answers the page's requests, and drive it
  with the pointer and the keyboard. Without Chrome the run fails and names Google Chrome; it
  never passes by skipping its tests.

## Known limits

- **A session with many sub-agents is read over a few refreshes.** An omp session's sub-agents
  are found by one `find` of the folder beside its session file, and a Claude Code session's by
  one `find` of the `subagents` folder of the folder named after its id, at each refresh. Of
  their transcripts that are new or changed since they were read, each refresh reads the 16
  newest, and the others at the next refreshes; a transcript once read is not read again until
  it changes. A running omp sub-agent's task is read from the first lines of its transcript
  once, and a Claude Code sub-agent's meta file, which names it, is read once. An opencode
  session's sub-agents are its child sessions in opencode's database, found by one query at each
  refresh and all read at once, again only when one of them changed, at most every 10 seconds.
- **A dead host slows every refresh.** ssh waits up to 5 seconds to connect to a host that does
  not answer. Once a command finds the host gone, spyhop asks it nothing more than its place
  (`uname -s`, `printenv HOME`), so each refresh still spends one 5-second attempt on it and the
  panel refreshes about every 5 seconds instead of every 2. The other hosts' groups are drawn
  at the start of each refresh, without waiting for it.
- **A shown Spend tab's refresh waits for every host.** Its range is answered after a catch-up
  once the last one started a minute ago or more, so each 60-second refresh waits for every Orca
  host to be read, and an unreachable host adds its 5-second ssh connect timeout.
- **An unreachable paired server disappears.** When its agents cannot be listed, its group is
  not drawn.
- **Other hosts' history is read over ssh, compressed only where `zstd` is.** The catch-up of
  the history store lists each other Orca host's session files and reads them and its opencode
  database with read-only commands (`find`, `stat`, `dd`, `tail`, `sqlite3 -readonly`), and
  parses them on this computer; nothing is written on that
  host. Once per catch-up it asks the host `zstd -V`: where that succeeds, the listings, the
  file bytes and the database's rows come through `zstd` and are decompressed here, never past
  the 8 MiB a raw answer may hold, else they come raw, so a host without `zstd` sends its files
  uncompressed.
- **Claude Code and opencode on other hosts are untested.** Their cards there may read `n/a`.
- **An opencode session's cost chart can end below its cost.** A session in opencode's current
  tables shows the total cost opencode keeps for it, which for some sessions is above the sum of
  the costs its model calls log; the cost chart, the Models section and the burn rate add up
  those calls, so they end below that total, and the cost card says how much opencode logged
  without a model call, the difference of the two. For such a session the card's burn rate and
  the cost card's per hour can disagree: the first sums the calls' costs of the last 10 minutes,
  the second is the total over the session's duration.
- **An omp sub-agent killed mid-tool reads running.** An omp sub-agent runs while its turn is
  open, as its transcript tells it: its newest message is not an answer that ended the turn,
  and omp wrote no exit entry after it. An omp killed hard writes no exit entry, so a sub-agent
  that was waiting on a tool then keeps reading running for as long as its Orca agent is listed.
  A transcript that ends before its session started is a copy omp made when it continued an
  earlier session, and does not run.
- **A Claude Code or opencode agent without a `sessionId` shows the newest session of the
  workspace folder.** With no title to tell sessions apart, such an agent (every one on a
  paired Orca server, which never gives a `sessionId`) shows the newest session of the
  workspace folder that no id names: another session's figures when several of them run
  there, and, when the harness runs in a sub-folder, the workspace folder's own newest session
  or `n/a` without one.
- **A Claude Code card may keep the workspace folder as its path.** A session file smaller
  than 256 KiB is searched whole for the folder the session started in. In a larger one the
  folder is looked for in the first 64 KiB only: such a session whose first prompt is larger
  than that shows the workspace folder and its branch.
- **An omp agent that has just started reads `n/a`** until Orca reports its `sessionId` or omp
  writes the session's title, which the agent's title then contains. On a paired Orca server,
  whose agents never have a `sessionId`, an omp agent whose title names no session (an
  untitled session, a title the pane does not show) stays `n/a`.
- **Two omp agents of nested workspace folders can show one session.** Two omp agents without
  a `sessionId`, in workspaces of which one folder is below the other, whose titles both
  contain one session's title, show that session on a card each, one in each workspace.
- **An old omp session may link a few refreshes late.** For the omp agents without a
  `sessionId`, one `find` lists the session files of the workspace folder and of the folders
  named like it, and each refresh reads the first two lines of at most 32 of them that are new
  or changed (`head`, the newest first, four at a time). A file once read is not read again
  until it changes, and one found to be of another folder never. So in a workspace with many
  sessions, an idle agent whose session is older than the 32 newest reads `n/a` for the first
  refreshes after Orca starts, one more for every 32 sessions newer than its own.
- **Some sub-folders are found only by `sessionId`.** The listing takes the session folders
  whose name starts like the workspace folder's. omp names the session folder of a sub-folder
  otherwise in two cases, a workspace folder above the home folder and a folder under the
  system temp folder: an omp agent there without a `sessionId` reads `n/a`.
- **A sub-folder is found by its path as omp recorded it.** A session counts as the workspace
  folder's when the folder it records starts with the path Orca gives for the workspace; one
  recorded under another spelling of that path (through a symbolic link) is not found by title.
