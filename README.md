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
| Identity | the agent's state (working, blocked, waiting, done), the session's title, the path (home as `~`), the git branch and remote and, for an agent on another host, the machine; the harness and the model |
| Context | the usage as a percent of the model's window, with tokens used, tokens left before compaction and compactions recorded |
| Spend | the cost the harness logged (there is no price table), cost per hour, tokens used by the session, tokens per minute |
| Cache | the time until the prompt cache is cold, and the hit rate with the turns that hit and missed it |
| Activity | session duration, time since the last message, last turn, thinking level, premium requests used |

Project and workspace rows carry Totals of cost, tokens and premium requests over the cards
under them. A Total reads `n/a` when any of those cards reads `n/a` for it, so a part is never
shown as the whole.

A figure the session does not give reads `n/a`; the plugin never estimates one.

## Harnesses

Cards read the harnesses' own session files, read-only: omp, Claude Code and opencode (its
database). An agent of any other harness gets a card whose figures all read `n/a`.

## How an agent is tied to a session

- **By session id**: when Orca reports the agent's `sessionId`, the card links to the session of
  that id, by the harness's own naming: for omp the session file `<start time>_<id>.jsonl`, for
  Claude Code the file `<id>.jsonl`, for opencode the database's session of that id. Agents on a
  paired Orca server have no `sessionId` (Orca's listing there gives only its own id), so they
  link as below.
- **Otherwise** (no `sessionId`, or one that names no session): the card links to the newest
  session of the workspace folder for the agent's harness. Several omp agents in one folder
  share out the newest sessions no id named by title: an agent whose title contains a session's
  title gets that session, and the agents left take the newest sessions no agent matched. A
  folder with no session is not linked, and every session figure on its card reads `n/a`.

## Other hosts

An agent on an SSH workspace, and an agent on a paired Orca server, get cards too, under their
own host row. Their session files and git facts are read over `ssh <alias> -o BatchMode=yes -o
ConnectTimeout=5`, at most four commands at once per host, with read-only commands only: `cd`,
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
  granted three capabilities: `workspace:read` and `agent:read` to list the workspaces and
  agents, and `workspace:write` for the Focus pane button only (`terminal.focus`, no other
  method of it). An installed spyhop without `workspace:write` asks for approval again when
  updated.
- Develop: `orca plugin dev watch .` loads the folder and reloads on each save;
  `orca plugin types .` writes the typings into `.orca/types/` (`npm run typecheck` also runs
  `tsc`).
- Test: `orca plugin test . --json` (`npm test`) runs the tests with Node's test runner and
  Orca's test kit; `orca plugin validate . --json` checks the manifest as Orca loads it.

## Known limits

- **A dead host slows every refresh.** ssh waits up to 5 seconds to connect to a host that does
  not answer. Once a command finds the host gone, spyhop asks it nothing more than its place
  (`uname -s`, `printenv HOME`), so each refresh spends one 5-second attempt on it and the panel
  refreshes about every 7 seconds instead of every 2.
- **An unreachable paired server disappears.** When its agents cannot be listed, its host row
  is not drawn.
- **Claude Code and opencode on other hosts are untested.** Their cards there may read `n/a`.
