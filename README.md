# spyhop

An Orca plugin that shows AI harness session stats for every Orca agent, on this computer and
on Orca's other hosts, in a panel of the right sidebar.

It is derived from [herdr-session-stats](https://github.com/jeffujioka/herdr-session-stats), a
herdr mod; the session readers and the card model in `src/core/` are copied from it, while
`src/core/limit.js` and `src/core/ttl-cache.js` are spyhop's own.

## What the panel shows

The panel is a tree: Orca host → Orca project → Orca workspace → agent cards. Only the
workspaces that have an Orca agent are listed, with the projects and hosts that hold them, in the
order Orca lists the agents. When the panel opens, the focused workspace, its project and its
host are expanded and every other row is collapsed. When focus moves to another workspace, that
workspace, its project and its host are expanded, and the workspace expanded for the previous
focus collapses unless you opened or closed it since; every other row stays as you leave it.

Above the tree, the Focused block shows the focused workspace: its name, with its host and
project under it, and its cards, Focus pane buttons included. It follows focus as soon as Orca
reports that focus moved; while the focused workspace has no Orca agent, it is not shown.

One card per harness session an agent links to (agents on one session share a card), and one
per agent that links to none. A card has five groups, always in this order:

| Group | Shows |
| --- | --- |
| Identity | the agent's state (working, blocked, waiting, done) and the rows Session, Path, Branch, Remote, Machine, Harness and Model, always in that order: the session's title, the path (home as `~`), the git branch and remote, the machine, the harness and the model. A row with nothing to show is not drawn: Session for an untitled agent, Branch and Remote for a folder that is no git repository or has no branch or no origin, Machine for an agent on this computer. Path, Harness and Model are always drawn, a model that cannot be read as `n/a`. The path is the folder the linked session records as its own, which can be a sub-folder of the Orca workspace folder, and the branch and remote are that folder's: for omp the folder of the session's `session` entry, for Claude Code the folder the session started in (the first `cwd` in its file), for opencode the session's `directory`. A card with no linked session, of another harness, or whose session tells no folder shows the workspace folder and its branch and remote |
| Context | the usage as a percent of the model's window, with tokens used, tokens left before compaction and compactions recorded |
| Spend | the cost the harness logged (there is no price table), cost per hour, tokens used by the session, tokens per minute |
| Cache | the time until the prompt cache is cold, and the hit rate with the turns that hit and missed it |
| Activity | session duration, time since the last message, last turn, thinking level, premium requests used |

Project and workspace rows carry Totals of cost, tokens and premium requests over the cards
under them. A Total reads `n/a` when any of those cards reads `n/a` for it, so a part is never
shown as the whole.

A figure the session does not give reads `n/a`; the plugin never estimates one. Only the
Identity group leaves a row out: the other four groups always draw every figure, so their rows
stay where they are from card to card.

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
own host row. Their session files and git facts are read over `ssh <alias> -o BatchMode=yes -o
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

While the panel is open it asks for the tree every 2 seconds, and at once when focus moves to
another workspace. While it is closed, hidden or unmounted it asks for nothing: a refresh that
was running when it closed runs to its end, and no other starts.

During a refresh each host's rows appear as soon as that host's cards are built, without waiting
for another host: this computer's are not held up by a slow SSH host or paired server. When the
refresh ends the whole tree replaces what is drawn, so the rows of a host that is gone
disappear then.

## What spyhop stores

Session totals only, in the plugin's own storage on this computer (`storage:own`): for each
session file larger than the 256 KiB a refresh reads from its end, the totals the session reader
counted over the file and the position they cover, by harness, machine and path. No session
text is stored, and nothing is written on any other host. They are there so that a file scanned
once is not scanned again from its start after Orca restarts: the reader goes on from the kept
position, and scans the file again when it is not the one that was scanned. They are written
at most once every 30 seconds, and only when a scan changed. Deleting the storage costs one
scan of each file, nothing else.

## Focus pane

A card whose agent has a pane shows a **Focus pane** button; a card whose agent has none (an
agent of a paired server in a pane no listed terminal is in, for one) shows no button. Pressing
it focuses that agent's pane in this computer's Orca window, showing its workspace, as clicking
the pane does; a card that agents share focuses the first of them in Orca's order. For an agent
on this computer or an SSH workspace it asks Orca through `terminal.focus`; for one on a paired
Orca server it runs `orca terminal switch --environment <name> --terminal <handle>`, the handle
`orca terminal list` gave for the pane. Neither writes anything on any host or runs anything
over ssh. A press that cannot focus changes nothing in the panel, and writes the reason to the
plugin's log (`orca plugin logs`). Orca's desktop app only.

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
  agents, `workspace:write` for the Focus pane button only (`terminal.focus`, no other
  method of it), and `storage:own` for the session totals it keeps (see What spyhop stores).
  An installed spyhop without `workspace:write` or `storage:own` asks for approval again when
  updated.
- Develop: `orca plugin dev watch .` loads the folder and reloads on each save;
  `orca plugin types .` writes the typings into `.orca/types/` (`npm run typecheck` also runs
  `tsc`).
- Test: `orca plugin test . --json` (`npm test`) runs the tests with Node's test runner and
  Orca's test kit; `orca plugin validate . --json` checks the manifest as Orca loads it.

## Known limits

- **A dead host slows every refresh.** ssh waits up to 5 seconds to connect to a host that does
  not answer. Once a command finds the host gone, spyhop asks it nothing more than its place
  (`uname -s`, `printenv HOME`), so each refresh still spends one 5-second attempt on it and the
  panel refreshes about every 5 seconds instead of every 2. The other hosts' rows are drawn at
  the start of each refresh, without waiting for it.
- **An unreachable paired server disappears.** When its agents cannot be listed, its host row
  is not drawn.
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
  than that shows the workspace folder and its branch and remote.
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
