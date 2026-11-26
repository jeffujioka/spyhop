// Copied from herdr-session-stats (src/session-link.js).
//
// Orca agent to session link. Pure and synchronous: the plugin lists the session folder and
// hands the files in as plain data; this module only decides.

// The files newest-modified first (a copy; files of one time keep their order).
export function newestFirst(files) {
  return [...files].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// files: [{ path, mtimeMs }] of the agent's workspace folder for the agent's harness. Returns
// the path of the newest-modified file, however long ago it changed (a running agent's session
// is the newest one; the activity figure shows how long it has been idle), or null when the
// folder has no session file (unlinked: every session figure reads 'n/a'; the plugin never
// guesses a session).
export function linkSession(files) {
  return newestFirst(files)[0]?.path ?? null;
}

// The Orca agents of one workspace folder (one Orca host, one harness that writes a title into
// its sessions), in Orca's order, share out the sessions they may link to. files: [{ path,
// mtimeMs, title }], `title` being the session's title; agentTitles: the agents' titles. Returns
// one file or null for each agent, in agent order: an agent whose title contains the non-empty
// title of a session gets that session, the longest title first when several match (the newer
// of two titles as long); a session goes to one agent only. An agent whose title contains no
// title left gets none, whatever the number of agents and sessions: a session it would take by
// its age can be another agent's or nobody's, and its card would show that session's figures as
// its own.
export function shareSessions(files, agentTitles) {
  const taken = new Set();
  const titled = newestFirst(files)
    .filter((file) => file.title)
    .sort((a, b) => b.title.length - a.title.length);
  return agentTitles.map((agentTitle) => {
    const match = titled.find((file) => !taken.has(file) && (agentTitle ?? '').includes(file.title));
    if (match) taken.add(match);
    return match ?? null;
  });
}

// The session files the Orca agents of one folder (one Orca host, one harness) link to, one
// file (or null) for each agent, in agent order. named: for each agent, the file its sessionId
// names by its harness's own rule (the provider hook's `named`), or null; candidates: as files
// for shareSessions, the files the agents left share out by title; agents: [{ title }].
export function linkAgents(named, candidates, agents) {
  const shared = shareSessions(candidates, agents.filter((_, i) => !named[i]).map((agent) => agent.title));
  return named.map((file) => file ?? shared.shift());
}

// agents: [{ sessionPath, ... }] of the Orca agents in Orca's order, `sessionPath` naming the
// session an agent links to and the workspace folder it does so from. Agents of the same
// session path share one card (the first of them); agents with no linked session (null) each
// keep their own.
export function collapseBySession(agents) {
  const seen = new Set();
  return agents.filter((agent) => {
    if (agent.sessionPath === null) return true;
    if (seen.has(agent.sessionPath)) return false;
    seen.add(agent.sessionPath);
    return true;
  });
}
