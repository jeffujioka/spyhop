# spyhop

An Orca plugin that shows AI harness session stats for every Orca agent, on this computer and
on Orca's other hosts, in a panel of the right sidebar.

It is derived from [herdr-session-stats](https://github.com/jeffujioka/herdr-session-stats), a
herdr mod; the session readers and the card model in `src/core/` are copied from it.

## What the panel shows

The panel is a tree: Orca host → Orca project → Orca workspace → agent cards. Only the
workspaces that have an Orca agent are listed, with the projects and hosts that hold them, in the
order Orca lists the agents. When the panel opens, the focused workspace, its project and its
host are expanded and every other row is collapsed; from then on the rows stay as you open and
close them.

One card per harness session an agent links to (agents on one session share a card), and one
per agent that links to none. A card has five groups, always in this order:

| Group | Shows |
| --- | --- |
| Identity | the agent's state (working, blocked, waiting, done), the session's title, the path (home as `~`), the git branch and remote and, for an agent on another host, the machine; the harness and the model |
| Context | the usage as a percent of the model's window, in a gauge, with tokens used, tokens left before compaction and compactions recorded |
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

- **omp**: Orca reports the agent's `sessionId`, and the card links to the session file of that
  id.
- **Otherwise** (Claude Code, opencode, and an omp agent without a `sessionId` or whose id names
  no file): the card links to the newest session file of the workspace folder for the agent's
  harness. Several agents of one harness in one folder share out the newest files by title: an
  agent whose title contains a session's title gets that session, and the agents left take the
  newest sessions no agent matched. A folder with no session file is not linked, and every
  session figure on its card reads `n/a`.

## Other hosts

An agent on an SSH workspace, and an agent on a paired Orca server, get cards too, under their
own host row. Their session files and git facts are read over `ssh <alias>`, with read-only
commands only (`cat`, `head`, `tail`, `stat`, `find`, `git branch`/`git remote`, `sqlite3
-readonly`). The hosts and the paired servers' agents are listed with the `orca` CLI (`orca host
list`, `orca environment list`, `orca agent list --environment <name>`). The plugin is installed
on the Mac only; nothing is installed on the other hosts.

## Refresh

While the panel is open it asks for the tree every 2 seconds. While it is closed, hidden or
unmounted nothing is read.

## Command and key

The palette command `Spyhop: Show session stats`, bound to `Mod+Alt+Shift+S` (Cmd on macOS,
Ctrl elsewhere), shows the panel in the right sidebar. Orca gives a plugin no call that shows its
own panel, so the command does it through the Orca CLI: it finds the plugin's key with `orca
plugin list` and runs `orca plugin open <key> --panel spyhop`.

## Install, develop, test

- Install from Git: `orca plugin install https://github.com/jeffujioka/spyhop`, or from a folder:
  `orca plugin install <dir>`. It runs code in a worker, so Orca asks for approval
  (`approval_required`) and prints the command to re-run with `--approve <fingerprint>`.
- Develop: `orca plugin dev watch .` loads the folder and reloads on each save;
  `orca plugin types .` writes the typings into `.orca/types/` (`npm run typecheck` also runs
  `tsc`).
- Test: `orca plugin test . --json` (`npm test`) runs the tests with Node's test runner and
  Orca's test kit; `orca plugin validate . --json` checks the manifest as Orca loads it.

## Known limits

- **Linking by id is omp only.** Claude Code and opencode agents are linked by folder and
  title; two of their agents in one folder can end up on the same session.
- **A dead host slows every refresh.** A host that does not answer holds each refresh up to the
  runner's timeout (10 seconds), so the whole panel then refreshes about every 12 seconds.
- **An unreachable paired server disappears.** When its agents cannot be listed, its host row
  is not drawn.
- **Claude Code and opencode on other hosts are untested.** Their cards there may read `n/a`.
