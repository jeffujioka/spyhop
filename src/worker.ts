// The plugin's own worker: answers the panel with the fleet of the Orca agents' cards on every
// Orca host (src/protocol.ts). Each request lists the Orca workspaces and, for those on this
// computer and on SSH hosts, the agents in each; for each paired Orca server `orca environment
// list` lists it lists that server's agents with the `orca` CLI (src/hosts.ts), as Orca's
// `workspace.list` lists no paired server's workspace. It builds their cards from the harnesses'
// session files, another host's read over `ssh` (src/agent-cards.ts), each Orca host's apart from
// the others', a paired server's started on the agents it listed at the previous refresh, while
// its lists load. Each card carries the time its agent entered its Orca state, as Orca gives it.
// `spyhop.fleet` posts each host's group to the panel (`spyhop.group`) as soon as that host's
// cards are built, and answers with the groups of them all, the burn rate card summed over every
// card and the attention list (src/fleet.ts), which carry no series of the session screen.
// `spyhop.session` builds
// the cards the same way, posts nothing, and
// answers with the session of the one card it asks for (src/session-detail.ts), or none when
// Orca no longer lists its agent. The session reader's totals of each scanned session file are
// kept in the plugin's storage (capability `storage:own`), and nothing else is there: they are loaded
// when the worker starts, which the first request waits for, and written at the end of a request
// when a scan changed, at most once every 30 seconds, so a file scanned before is not scanned
// again from its start. Orca stores no value over 256 KiB, so they are split over the keys
// `session-totals`, `session-totals.1` and on. The CLI runs on each request, so only while the
// panel is open, and for the palette command `spyhop.show`, which shows the panel. Apart from
// them, a catch-up reads this computer's omp session files into the history store
// (src/history/catch-up.ts) when the worker starts and every CATCH_UP_MS after.
// `spyhop.range` answers a range tab from the history store (src/history/views.ts): at once while
// a catch-up runs, else after a catch-up when the last one started RANGE_REFRESH_MS ago or more.
// A history store that cannot be opened is logged once; no catch-up runs then, and each range
// tab's figures are n/a, while the fleet and the sessions are answered as ever.
// `spyhop.focus` focuses a card's pane
// in this computer's Orca window: an agent on this computer or an SSH workspace by Orca's
// `terminal.focus`, one on a paired Orca server by `orca terminal switch` to the server's
// terminal; neither runs anything over ssh. A press that cannot focus answers `focused: false`
// and writes the reason to the worker's log.
import { homedir } from 'node:os';
import type { OrcaWorkerApi } from 'orca/worker';
import { type BuiltCard, createAgentCards, type OrcaAgent, sameButStates } from './agent-cards.ts';
import { cardView } from './card-view.ts';
import { CATCH_UP_MS, decodeScans, encodeScans, keptPartsOf, RANGE_REFRESH_MS } from './core/refresh.js';
import { createTtlCache } from './core/ttl-cache.js';
import { run } from './exec.ts';
import { attentionRows, burnCard, type FleetAgent, groupCards, LOCAL, stateCounts } from './fleet.ts';
import { orca as cli, type HostLists, listHosts, readServerAgents, type RemoteHost, remoteHosts, type ServerAgent } from './hosts.ts';
import type { CardView, FleetAnswer, HostGroup, Pane, RangeAnswer, SessionAnswer, SpendView } from './protocol.ts';
import { type CatchUp, createCatchUp } from './history/catch-up.ts';
import { openStore, type Store } from './history/store.ts';
import { spendView } from './history/views.ts';
import { sessionDetail } from './session-detail.ts';

// How long Orca's lists of hosts and paired servers are kept: a server is paired seldom, its
// agents change each refresh.
const HOST_LISTS_TTL_MS = 60 * 1000;
// The key of the plugin's storage that holds the first part of the kept scans
// (src/core/refresh.js), the key of each later part, and the least time between two writes of
// them.
const KEPT_KEY = 'session-totals';
const keptKey = (part: number) => (part === 0 ? KEPT_KEY : `${KEPT_KEY}.${part}`);
const KEPT_WRITE_MS = 30 * 1000;

// The Spend tab's view when the history store cannot be opened.
const SPEND_NA: SpendView = { cost: 'n/a', tokens: 'n/a', calls: 'n/a', chart: null };

// Runs `catchUp`, or waits for the one running; a run that fails is logged, and resolves.
function caughtUp(catchUp: CatchUp, log: (message: string) => void) {
  return catchUp.run().catch((error) => log(`spyhop: catch-up failed: ${(error as Error).message}`));
}

// Runs `catchUp` at once and again CATCH_UP_MS after each run started, whether the panel is open
// or not; a run that fails is logged. Returns the stop: no further run starts, and it resolves
// once the running one has ended.
export function scheduleCatchUps(catchUp: CatchUp, log: (message: string) => void) {
  let timer: NodeJS.Timeout;
  const next = () => {
    timer = setTimeout(next, CATCH_UP_MS);
    caughtUp(catchUp, log);
  };
  next();
  return async () => {
    clearTimeout(timer);
    if (catchUp.running()) await catchUp.run().catch(() => {});
  };
}

// What `deactivate` ends: the catch-ups and the history store of the active worker.
let ending: (() => Promise<void>) | null = null;

export async function deactivate() {
  await ending?.();
  ending = null;
}

export default function activate(orca: OrcaWorkerApi): void {
  const home = homedir();
  const log = (message: string) => orca.log(message);
  // The history store, which the catch-ups fill from the worker's start (src/history/catch-up.ts),
  // and its catch-up; null when it cannot be opened, `node:sqlite` not loaded included.
  const opening = openStore(home).then(
    (store) => {
      const catchUp = createCatchUp({ run, store, home, log });
      const stopCatchUps = scheduleCatchUps(catchUp, log);
      return { store, catchUp, stopCatchUps };
    },
    (error) => {
      log(`spyhop: cannot open the history store: ${(error as Error).message}`);
      return null;
    },
  );
  ending = async () => {
    const history = await opening;
    if (!history) return;
    await history.stopCatchUps();
    history.store.close();
  };
  // The card builder, kept for the worker's life: it keeps the state of its session reads
  // between builds, which start from the scans the storage holds. A storage that cannot be read
  // (the capability not granted), or holds anything but this version's kept scans, gives none.
  const starting = (async () => {
    const first = await orca.storage.get(KEPT_KEY);
    const later = await Promise.all(Array.from({ length: keptPartsOf(first) - 1 }, (_, i) => orca.storage.get(keptKey(i + 1))));
    return decodeScans([first, ...later]);
  })()
    .catch(() => [])
    .then((kept) => createAgentCards({ run, home, kept }));
  type Cards = Awaited<typeof starting>;
  // when the kept scans were last written, or tried to, and whether a scan has changed that no
  // write holds yet
  let keptAt = -Infinity;
  let unkept = false;
  const hostLists = createTtlCache(HOST_LISTS_TTL_MS);
  // hostId of a paired server -> the agents it listed at the previous refresh
  const listedBefore = new Map<string, ServerAgent[]>();

  // The agents the paired server `hostId` lists now, and their cards. The cards of the agents it
  // listed at the previous refresh are built while its lists load: they are the cards when the
  // new list names the same agents, but for their states and the times they entered them, which
  // are the new list's. When it
  // differs, the cards are built again from the new list, once the early build has ended, so
  // that no session file is read twice at once and the unchanged ones' reads are found kept.
  async function serverCards(cards: Cards, hostId: string, host: RemoteHost) {
    const before = listedBefore.get(hostId) ?? [];
    const early = cards.build(before, Date.now());
    const agents = await readServerAgents(run, hostId, host, (message) => orca.log(message));
    listedBefore.set(hostId, agents);
    if (sameButStates(before, agents)) {
      const listed = new Map(agents.map((agent) => [agent.id, agent]));
      return {
        agents,
        cards: (await early).map((card) => ({ ...card, status: listed.get(card.id)!.state, stateSince: listed.get(card.id)!.stateSince ?? null })),
      };
    }
    await early;
    return { agents, cards: await cards.build(agents, Date.now()) };
  }

  // Orca gives a plugin no call that shows its own panel; its CLI does, by the key Orca installed
  // the plugin under (`local.spyhop` from a folder, `<owner>.spyhop` from Git): the listed one
  // that contributes the panel `spyhop` and is not disabled. Both installs can be listed at once,
  // but they share the key binding, so Orca runs only one of them, the one this worker is in,
  // and refuses to open a panel of the disabled one.
  orca.commands.register('spyhop.show', async () => {
    const { plugins } = await cli(run, ['plugin', 'list']);
    const self = plugins.find(
      (plugin: { pluginKey: string; status: string; panels?: { id: string }[] }) =>
        plugin.pluginKey.endsWith('.spyhop') &&
        plugin.status !== 'disabled' &&
        plugin.panels?.some((panel) => panel.id === 'spyhop'),
    );
    if (!self) throw new Error('Orca lists no spyhop plugin');
    await cli(run, ['plugin', 'open', self.pluginKey, '--panel', 'spyhop']);
  });

  // One Orca host's agents, in the order Orca lists them, and their cards.
  type HostBuilt = { agents: (FleetAgent & { pane?: Pane | null })[]; cards: BuiltCard[] };

  // The cards of every Orca agent, built once per request: the agents in the order Orca lists
  // them, the built cards, each card's view by its id and each remote host's name by its id.
  // `post` is given each Orca host's group as soon as its cards are built; a host with no agent
  // has no group. The kept scans are written at the end of it.
  async function build(post: ((group: HostGroup) => void) | null) {
    const cards = await starting;
    const [{ workspaces }, listed] = await Promise.all([
      orca.host.call('workspace.list'),
      hostLists('hosts', Date.now(), () => listHosts(run)) as Promise<HostLists>,
    ]);
    const hostOf = (workspace: (typeof workspaces)[number]) => workspace.hostId ?? LOCAL;
    // A paired server's agents come from its own `orca agent list`; the others' workspaces are
    // asked here. `agents.list` lists one workspace's agents. Its `sessionId` is the harness's
    // own session id (what `agent.resume` takes), so a card links by it
    // (src/core/session-link.js). A workspace whose agents cannot be listed (removed since
    // `workspace.list`) shows none, and the others are drawn.
    const asked = workspaces.filter((workspace) => !hostOf(workspace).startsWith('runtime:'));
    const remote = remoteHosts(listed, [...new Set(asked.map(hostOf).filter((hostId) => hostId !== LOCAL))]);
    // as Orca names each host; this computer, which the lists do not name, is `local`
    const names = new Map([...remote].map(([hostId, host]) => [hostId, host.name]));
    // agent id -> its pane, for an agent Orca names a terminal of
    const panes = new Map<string, Pane>();
    const views = new Map<string, CardView>();
    // each asked workspace's agents, in the order of `asked`
    const listing = asked.map(async (workspace) => {
      const hostId = hostOf(workspace);
      const { agents } = await orca.host.call('agents.list', { workspaceId: workspace.id }).catch(() => ({ agents: [] }));
      return agents.map((agent, n): OrcaAgent & FleetAgent => {
        const id = `${workspace.id}\0${agent.terminalId ?? n}`;
        if (agent.terminalId) panes.set(id, { terminalId: agent.terminalId });
        return {
          id,
          agent: agent.agent,
          state: agent.state,
          title: agent.title,
          sessionId: agent.sessionId,
          path: workspace.path,
          machine: remote.get(hostId)?.alias ?? null,
          stateSince: agent.stateStartedAt,
          hostId,
          workspaceId: workspace.id,
        };
      });
    });
    // the agents of the asked workspaces on the Orca host `hostId` and their cards, which wait
    // for no other host's lists or session reads
    async function workspaceCards(hostId: string): Promise<HostBuilt> {
      const agents = (await Promise.all(listing.filter((_, i) => hostOf(asked[i]) === hostId))).flat();
      return { agents, cards: await cards.build(agents, Date.now()) };
    }
    // One Orca host's agents and cards, once built: their views, and its group posted.
    async function posted(building: Promise<HostBuilt>) {
      const built = await building;
      for (const agent of built.agents) if (agent.pane) panes.set(agent.id, agent.pane);
      const now = Date.now();
      for (const card of built.cards) views.set(card.id, cardView(card, { home, pane: panes.get(card.id) ?? null, now }));
      if (post) for (const group of groupCards(built.agents, built.cards.map((card) => views.get(card.id)!), names)) post(group);
      return built;
    }
    const [others, servers] = await Promise.all([
      Promise.all([...new Set(asked.map(hostOf))].map((hostId) => posted(workspaceCards(hostId)))),
      Promise.all([...remote].filter(([hostId]) => hostId.startsWith('runtime:')).map(([hostId, host]) => posted(serverCards(cards, hostId, host)))),
    ]);
    // The kept scans are written when one changed and the last write, or try, is 30 s old. A
    // write that fails is tried again by the first refresh 30 s later, and fails no request. The
    // first part, which names how many there are, is written last, so that a write that fails
    // midway leaves the earlier first part; the parts it names then mix two writes, each scan
    // of them a finished scan of its file, which a reader safely goes on from. The later parts
    // of an earlier, larger write are removed once the new ones are written; a removal that
    // fails is logged as such, for the totals are kept, and the parts are left to a later write.
    const now = Date.now();
    if (now - keptAt >= KEPT_WRITE_MS) {
      const { changed, scans } = cards.scanned();
      unkept ||= changed;
      if (unkept) {
        keptAt = now;
        try {
          const parts = encodeScans(scans);
          for (let part = parts.length - 1; part >= 0; part--) await orca.storage.set(keptKey(part), parts[part]);
          unkept = false;
          try {
            const left = (await orca.storage.keys()).filter((key) => key.startsWith(`${KEPT_KEY}.`) && Number(key.slice(KEPT_KEY.length + 1)) >= parts.length);
            for (const key of left) await orca.storage.delete(key);
          } catch (error) {
            orca.log(`spyhop: cannot remove the old session-totals keys: ${(error as Error).message}`);
          }
        } catch (error) {
          orca.log(`spyhop: cannot keep the session totals: ${(error as Error).message}`);
        }
      }
    }
    return {
      // in the order Orca lists them, which is the order of the groups
      agents: [...(await Promise.all(listing)).flat(), ...servers.flatMap(({ agents }) => agents)],
      views,
      cards: [...others, ...servers].flatMap((built) => built.cards),
      names,
    };
  }

  orca.panels.handle('spyhop.fleet', async ({ request }): Promise<FleetAnswer> => {
    const { agents, views, cards, names } = await build((group) => {
      // a post Orca refuses (too large, too many) leaves the answer to draw the group
      try {
        orca.panels.post('spyhop.group', { request, group });
      } catch (error) {
        orca.log(`spyhop: cannot post the group of ${group.name}: ${(error as Error).message}`);
      }
    });
    const now = Date.now();
    return {
      request,
      groups: groupCards(agents, [...views.values()], names),
      counts: stateCounts(agents),
      burn: burnCard(cards, now),
      attention: attentionRows(agents, cards, now),
    };
  });

  orca.panels.handle('spyhop.session', async ({ request, card: id }): Promise<SessionAnswer> => {
    const { agents, cards, views, names } = await build(null);
    const card = cards.find((built) => built.id === id);
    if (!card) return { request, session: null };
    const { hostId } = agents.find((agent) => agent.id === id)!;
    const host = hostId === LOCAL ? null : (names.get(hostId) ?? hostId);
    return { request, session: sessionDetail(card, { home, host, view: views.get(id)!, now: Date.now() }) };
  });

  orca.panels.handle('spyhop.range', async ({ request, tab, range }): Promise<RangeAnswer> => {
    const history = await opening;
    if (!history) return { request, tab, range, spend: tab === 'spend' ? SPEND_NA : null };
    const { store, catchUp } = history;
    if (!catchUp.running() && Date.now() - (catchUp.startedMs() ?? -Infinity) >= RANGE_REFRESH_MS) await caughtUp(catchUp, log);
    return { request, tab, range, spend: tab === 'spend' ? spendView(store, range, Date.now()) : null };
  });

  orca.panels.handle('spyhop.focus', async (pane: Pane) => {
    try {
      if ('environment' in pane) {
        // `navigated` false: no desktop here shows that server; an answer without it focused nothing
        const { focus } = await cli(run, ['terminal', 'switch', '--environment', pane.environment, '--terminal', pane.terminal]);
        const focused = focus?.navigated === true;
        if (!focused) orca.log(`spyhop: no Orca window here shows ${pane.environment}: did not navigate to the terminal ${pane.terminal}`);
        return { focused };
      }
      const { focused } = await orca.host.call('terminal.focus', { terminalId: pane.terminalId });
      if (!focused) orca.log(`spyhop: Orca did not focus the terminal ${pane.terminalId}`);
      return { focused };
    } catch (error) {
      const terminal = 'environment' in pane ? `${pane.terminal} of ${pane.environment}` : pane.terminalId;
      orca.log(`spyhop: cannot focus the terminal ${terminal}: ${(error as Error).message}`);
      return { focused: false };
    }
  });
}
