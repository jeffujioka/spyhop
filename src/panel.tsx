// The right-sidebar panel: the tree of Orca host → Orca project → Orca workspace → cards, as the
// worker answers it (src/protocol.ts), each Orca host's row drawn as soon as the worker posts
// it, before the answer; asked again REFRESH_INTERVAL_MS after the previous ask
// started, or at its answer when that came later, while the panel is
// open and never while it is closed, hidden or unmounted, and at once when Orca reports that
// focus moved to another Orca workspace. The rows follow focus: when the panel opens, the focused
// Orca workspace, its project and its host are expanded and every other row collapsed; when focus
// moves, the newly focused workspace, its project and host are expanded, at once when the tree
// drawn has its row, and the workspace row expanded for the previous focus collapses unless the
// developer opened or closed it since. Any other row stays as the developer opens and closes
// it. Above the tree, the Focused block shows the focused Orca workspace's name, its host and
// project, and its cards; it follows focus as the rows do, and is not drawn while the focused
// workspace has no row. A card whose agent has a pane shows a Focus pane button, which asks the
// worker to focus that pane in this computer's Orca window.
import {
  atom,
  Badge,
  Button,
  Card,
  Collapsible,
  EmptyState,
  KeyValue,
  on,
  plugin,
  read,
  set,
  Spinner,
  Stack,
  type PanelContext,
  type ReadonlyAtom,
  type Tone,
  update,
} from 'orca';
import { REFRESH_INTERVAL_MS } from './core/refresh.js';
import type { CardView, TreeAnswer } from './protocol.ts';
import { type Totals, withHost, type WorkspaceRow } from './tree.ts';

// The tree drawn: what the worker answered, with the host rows it posted since; null until
// either.
const tree = atom<TreeAnswer | null>(null);
// The rows drawn open, and those the developer opened or closed since the panel last expanded
// them for focus.
const opened = atom<ReadonlySet<string>>(new Set());
const touched = atom<ReadonlySet<string>>(new Set());
// The focused Orca workspace's row, as followFocus last resolved it; null when the focused
// workspace has no row.
const focusedRow = atom<string | null>(null);

// `rows`, with the row `id` in or out of it.
function withRow(rows: ReadonlySet<string>, id: string, included: boolean): ReadonlySet<string> {
  const next = new Set(rows);
  if (included) next.add(id);
  else next.delete(id);
  return next;
}

// The first workspace row of `hosts` that `match` picks, with its project and host; undefined
// when none does.
function placeOf(hosts: TreeAnswer['hosts'], match: (workspace: WorkspaceRow<CardView>) => boolean) {
  for (const host of hosts) {
    for (const project of host.projects) {
      const workspace = project.workspaces.find(match);
      if (workspace) return { host, project, workspace };
    }
  }
  return undefined;
}

// The developer opened or closed the row `id`.
function toggled(id: string, open: boolean) {
  update(opened, (rows) => withRow(rows, id, open));
  update(touched, (rows) => withRow(rows, id, true));
}

// The Orca tone of a card's status (src/core/card-model.js), one each for Orca's four states.
const STATUS_TONES: Record<string, Tone> = {
  working: 'accent',
  blocked: 'danger',
  waiting: 'warning',
  done: 'success',
};
// The Orca tone of a figure's tone; other tones draw plain.
const FIGURE_TONES: Record<string, Tone> = { ok: 'success', warning: 'warning', danger: 'danger' };

// This panel run's refresh, made by `setup`: `follow(visible)` asks the worker now and then every
// REFRESH_INTERVAL_MS while `visible`, and stops while not. Orca reports `visible` as an atom
// that only a render can watch, so the panel's render hands it on.
let refresh: { visible: ReadonlyAtom<boolean>; follow: (visible: boolean) => void } | null = null;
// How many requests for the tree the panel made since the module loaded, every run of the panel
// counted: the number of the newest, which no other request has.
let requests = 0;

export function setup({ signal, subscriptions, visible }: PanelContext): void {
  // clears the timer of the next ask; null when none is set: it ran out, or the panel was hidden
  let cancel: (() => void) | null = null;
  let asking = false;
  // focus moved during an ask, whose answer may predate it: ask again once it is in
  let again = false;
  let shown = false;
  // Orca's id of the focused workspace as the last answer or event that moved focus named it;
  // and the workspace row expanded for that focus, null until its row is drawn
  let focus: string | null = null;
  let expanded: string | null = null;
  // how many times Orca reported focus moving; an answer asked before the latest move names
  // a focus that may be gone, so its own moves none
  let moves = 0;
  // `moves` when the newest request started
  let asked = 0;

  // Focus moves to Orca's workspace `id`; null, no workspace focused, moves none. When it moves,
  // the workspace row expanded for the previous focus collapses unless the developer opened or
  // closed it since. The focused row is the row of `hosts` whose agents Orca reports focus by
  // `id`, none when no row is; it, its project and its host expand once `hosts` holds it.
  function followFocus(id: string | null, hosts: TreeAnswer['hosts']) {
    if (id === null) return;
    if (id !== focus) {
      focus = id;
      const previous = expanded;
      if (previous && !read(touched).has(previous)) update(opened, (rows) => withRow(rows, previous, false));
      expanded = null;
    }
    const place = placeOf(hosts, (workspace) => workspace.workspaceIds.includes(id));
    set(focusedRow, place?.workspace.id ?? null);
    if (expanded !== null || !place) return;
    const row = place.workspace.id;
    update(opened, (open) => new Set([...open, place.host.id, place.project.id, row]));
    update(touched, (open) => withRow(open, row, false));
    expanded = row;
  }

  // An answer asked before focus last moved resolves the focus the panel holds, not its own.
  function draw(answer: TreeAnswer, current: boolean) {
    followFocus(current ? answer.focused : focus, answer.hosts);
    set(tree, answer);
  }

  // Asks the worker, and sets the timer of the next ask, REFRESH_INTERVAL_MS from this one's
  // start. Never two asks at once: a timer that runs out during an ask leaves the next to its answer.
  function ask() {
    cancel?.();
    const timer = setTimeout(() => {
      cancel = null;
      if (!asking) ask();
    }, REFRESH_INTERVAL_MS);
    cancel = () => clearTimeout(timer);
    asking = true;
    again = false;
    asked = moves;
    requests += 1;
    plugin
      .request('spyhop.tree', { request: requests }, { signal })
      .then((answer) => draw(answer, asked === moves))
      // a failed answer keeps the last tree drawn; the next refresh asks again
      .catch(() => undefined)
      .finally(() => {
        asking = false;
        // the next ask is due at once when focus moved or no timer is left to start it
        if (shown && (again || !cancel)) ask();
      });
  }

  function follow(next: boolean) {
    shown = next && !signal.aborted;
    if (!shown && cancel) {
      cancel();
      cancel = null;
    } else if (shown && !cancel && !asking) {
      ask();
    }
  }

  // A host row the worker posts is drawn only while the request it was built for is being asked:
  // one of an older request, or of a request whose answer is drawn, is ignored. It takes the
  // place of the drawn row of its host, or goes after the rows drawn, and follows focus as an
  // answer does.
  subscriptions.push(
    plugin.on('spyhop.host', ({ request, host, focused }) => {
      if (asking && request === requests) draw({ hosts: withHost(read(tree)?.hosts ?? [], host), focused }, asked === moves);
    }),
  );

  // Orca's id of the focused workspace as `workspace.changed` last reported it: the event also
  // reports the focused workspace's terminals changing, which moves no focus
  let reported: string | null | undefined;
  subscriptions.push(
    on('workspace.changed', ({ context }) => {
      const id = context?.workspaceId ?? null;
      if (id === reported) return;
      reported = id;
      moves += 1;
      // the rows and the Focused block follow at once from the tree drawn, shown or hidden,
      // without waiting for the worker, whose answer waits for every host's session reads
      followFocus(id, read(tree)?.hosts ?? []);
      // an answer being asked may predate the move: it is asked again once in
      if (asking) {
        again = true;
      } else if (shown) {
        // hidden, the panel asks nothing; shown again, it asks at once
        ask();
      }
    }),
  );
  signal.addEventListener('abort', () => follow(false));
  refresh = { visible, follow };
}

const totalsText = ({ cost, tokens, premium }: Totals) => `${cost} · ${tokens} tokens · ${premium} premium`;

// An identity row that is drawn only when it has a value: none for a null, undefined or empty
// one, which Orca's KeyValue would draw as `–` and which reads as broken where there is nothing
// to show (no title, no git repository, this computer).
const rowWithValue = (label: string, value: string | null | undefined) => (value == null || value === '' ? [] : [{ label, value }]);

function cardOf({ id, groups: [identity, ...groups], pane }: CardView) {
  return (
    <Card key={id} title={identity.name.value} description={identity.session?.value}>
      <Stack gap="sm">
        <Badge tone={STATUS_TONES[identity.status.label] ?? 'neutral'}>{identity.status.label}</Badge>
        <KeyValue
          label="IDENTITY"
          // one order on every card, so that cards of one kind line up; Path, Harness and Model
          // are always drawn, a Model that cannot be read as n/a
          items={[
            ...rowWithValue('Session', identity.session?.value),
            { label: 'Path', value: identity.path.value },
            ...rowWithValue('Branch', identity.branch),
            ...rowWithValue('Remote', identity.remote),
            ...rowWithValue('Machine', identity.machine),
            { label: 'Harness', value: identity.harness.value },
            { label: 'Model', value: identity.model.value },
          ]}
        />
        {groups.map((group) => (
          <KeyValue
            key={group.id}
            label={group.title}
            items={[
              ...(group.hero ? [{ label: group.title, value: `${group.hero.value} ${group.hero.label ?? ''}`.trim(), tone: FIGURE_TONES[group.hero.tone] }] : []),
              ...group.figures.map((figure) => ({ label: figure.label ?? '', value: figure.value, tone: FIGURE_TONES[figure.tone] })),
            ]}
          />
        ))}
        {pane && (
          // a press the worker cannot answer changes nothing; the worker logs why it could not focus
          <Button icon="terminal" onPress={() => plugin.request('spyhop.focus', pane).catch(() => undefined)}>
            Focus pane
          </Button>
        )}
      </Stack>
    </Card>
  );
}

export default function Panel() {
  refresh?.follow(read(refresh.visible));
  const answer = read(tree);
  if (!answer) return <Spinner label="Reading the Orca agents" />;
  if (answer.hosts.length === 0) return <EmptyState title="No Orca agents" icon="agent" />;
  const open = read(opened);
  const focusedId = read(focusedRow);
  const focused = placeOf(answer.hosts, (workspace) => workspace.id === focusedId);
  return (
    <Stack gap="sm">
      {focused && (
        <Card key="focused" title={focused.workspace.name} description={`${focused.host.name} · ${focused.project.name}`}>
          <Stack gap="sm">{focused.workspace.cards.map(cardOf)}</Stack>
        </Card>
      )}
      {answer.hosts.map((host) => (
        <Collapsible key={host.id} title={host.name} open={open.has(host.id)} onChange={(next) => toggled(host.id, next)}>
          {host.projects.map((project) => (
            <Collapsible
              key={project.id}
              title={project.name}
              description={totalsText(project.totals)}
              open={open.has(project.id)}
              onChange={(next) => toggled(project.id, next)}
            >
              {project.workspaces.map((workspace) => (
                <Collapsible
                  key={workspace.id}
                  title={workspace.name}
                  description={totalsText(workspace.totals)}
                  open={open.has(workspace.id)}
                  onChange={(next) => toggled(workspace.id, next)}
                >
                  <Stack gap="sm">
                    {workspace.cards.map(cardOf)}
                  </Stack>
                </Collapsible>
              ))}
            </Collapsible>
          ))}
        </Collapsible>
      ))}
    </Stack>
  );
}
