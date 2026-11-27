# spyhop

An Orca plugin that shows AI harness session stats for every Orca agent, on this computer and
on Orca's other hosts, in a panel of the right sidebar.

It is derived from [herdr-session-stats](https://github.com/jeffujioka/herdr-session-stats), a
herdr mod; the session readers in `src/core/` are copied from it, while `src/core/limit.js`,
`src/core/series.js` and `src/core/ttl-cache.js` are spyhop's own.

## What the panel shows

The panel is the Live panel, an HTML panel drawn in Orca's own theme, light or dark, which
follows a change of theme without being loaded again. It opens on the fleet screen:

- **The header**: `Spyhop`, a `live` mark, and the number of agents in each Orca state
  (blocked, waiting, working, done) that any agent is in. The counts are drawn once a whole
  refresh is answered, never from part of one.
- **A group per Orca host**, this computer's (`local`) first, then the others in the order Orca
  lists their first agent, each with the number of its cards. There are no project or workspace
  rows. A group's cards go by Orca state: blocked, waiting, working, done.
- **A card per session** whose agent is not done (agents on one session share a card, and an
  agent that links to no session has a card of its own): the session's title (the folder's name
  for an untitled one), its cost as the harness logged it (there is no price table), the folder,
  git branch, harness and model, the agent's state and how long it has been in it, and its
  context: the percent of the model's window used, the tokens used and the window, a bar marking
  where the harness compacts on its own, and a spark line of the context after each of the last
  30 model calls. From 75% of the window, a chip tells the tokens left before compaction.
- **A done agent's session on one folded line**: its title, folder, context and cost.

Pressing a card or a folded line, by a click or by Enter or Space once it has the keyboard's
focus, opens that session's screen at once, with its header from the card, and its back control
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
  - the cost over time, of the session's own model calls and of its sub-agents, with the total
    as the harness logged it.
- **Tools**: the six tools called most, the rest summed as `others`, each with its failures.
- **Models**: the cost by model, or the tokens for a harness that logs no cost per call
  (Claude Code), each with what used it: the main agent, the sub-agents.
- **Session**: when it started, the thinking level, the time to the last reply, the premium
  requests, and the branch, remote and Orca host where there is one.

A model call is a call that logged usage. An omp call that logged none, or a usage of all zeros
(one omp aborted, or that failed before the model answered), is not counted: not in the model
calls, the charts or the cold starts. A part with nothing to show, such as the charts of a
session without a model call, is not drawn.

## Harnesses

Cards read the harnesses' own session files, read-only: omp, Claude Code and opencode (its
database). An agent of any other harness gets a card whose figures all read `n/a`.

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
    never takes another session by its age.
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
`find` with `stat`, `git branch --show-current`, `git remote get-url` and `sqlite3 -readonly`.
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
session, every 2 seconds: each request starts 2 seconds after the previous one started, or as
soon as that one is answered when it took longer, and never while another is unanswered. While
it is closed or hidden it asks for nothing: a refresh that was running when it closed runs to its
end, and no other starts. A refresh that fails leaves the screen as it was, and the next one
draws it again. Opening a session's screen, or going back to the fleet, asks at once, or as soon
as the request out is answered.

During a refresh each host's group appears as soon as that host's cards are built, without
waiting for another host: this computer's are not held up by a slow SSH host or paired server.
When the refresh ends its whole answer replaces what is drawn, so the group of a host that is
gone disappears then, and the header's counts are drawn from it. A group built for an older
refresh is never drawn.

## What spyhop stores

Session totals only, in the plugin's own storage on this computer (`storage:own`); the panel's
page keeps nothing of its own, and shows only what the worker answers. For each
session file larger than the 256 KiB a refresh reads from its end, the totals the session reader
counted over the file, the context sizes of its last 30 model calls, the tokens, cost and context
of all its model calls in at most 120 points (neighbouring calls summed once there are more), its
compactions with their tokens before and after, its cold starts, its tool calls and failures by
tool name, the ids of its tool calls not answered yet (with their tool's name, so that a later
answer counts its failure), its cost and tokens by model name, and the position they cover, by
harness, machine and path. No session text is stored, and nothing is written on any
other host. They are there so that a file scanned once is not scanned again from its start after
Orca restarts: the reader goes on from the kept position, and scans the file again when it is
not the one that was scanned. They are written at most once every 30 seconds, and only when a
scan changed. Deleting the storage costs one scan of each file, nothing else; so does an update
of spyhop that keeps more of a session, which discards what an earlier version kept, once.

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
plugin list` and runs `orca plugin open <key> --panel spyhop`.

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
  as the dev plugin `local.spyhop`, opens the Live panel, asks the worker for the fleet with
  `orca plugin dev request`, then shoots the panel 300 and 420 pixels wide on this computer's
  own agents (the PNGs go to `.orca/shots/`) and fails on a `[frame]` error in
  `orca plugin logs`; it unloads the folder when it exits. `orca plugin check` lists no HTML
  panel and `orca plugin shot --scenario` refuses one, so the panel has no check scenarios: the
  session screen's look is checked by eye. Orca asks for the dev plugin's approval again after
  every change to a file of the folder, and the check prints the command that gives it.

## Known limits

- **A dead host slows every refresh.** ssh waits up to 5 seconds to connect to a host that does
  not answer. Once a command finds the host gone, spyhop asks it nothing more than its place
  (`uname -s`, `printenv HOME`), so each refresh still spends one 5-second attempt on it and the
  panel refreshes about every 5 seconds instead of every 2. The other hosts' groups are drawn
  at the start of each refresh, without waiting for it.
- **An unreachable paired server disappears.** When its agents cannot be listed, its group is
  not drawn.
- **Claude Code and opencode on other hosts are untested.** Their cards there may read `n/a`.
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
