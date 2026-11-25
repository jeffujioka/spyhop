// The right-sidebar panel: the tree of Orca host → Orca project → Orca workspace → cards, as the
// worker answers it (src/protocol.ts), asked again every REFRESH_INTERVAL_MS while the panel is
// open and never while it is closed, hidden or unmounted, and at once when Orca reports that
// focus moved to another Orca workspace. The rows follow focus: when the panel opens, the focused
// Orca workspace, its project and its host are expanded and every other row collapsed; when focus
// moves, the newly focused workspace, its project and host are expanded, and the workspace row
// expanded for the previous focus collapses unless the developer opened or closed it since. Any
// other row stays as the developer opens and closes it. A card whose agent has a pane shows a
// Focus pane button, which asks the worker to focus that pane in this computer's Orca window.
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
import type { Totals } from './tree.ts';

// What the worker answered; null until it does.
const tree = atom<TreeAnswer | null>(null);
// The rows drawn open, and those the developer opened or closed since the panel last expanded
// them for focus.
const opened = atom<ReadonlySet<string>>(new Set());
const touched = atom<ReadonlySet<string>>(new Set());

// `rows`, with the row `id` in or out of it.
function withRow(rows: ReadonlySet<string>, id: string, included: boolean): ReadonlySet<string> {
  const next = new Set(rows);
  if (included) next.add(id);
  else next.delete(id);
  return next;
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

export function setup({ signal, subscriptions, visible }: PanelContext): void {
  // clears the timer of the next ask; null when none is set
  let cancel: (() => void) | null = null;
  let asking = false;
  // focus moved during an ask, whose answer may predate it: ask again once it is in
  let again = false;
  let shown = false;
  // the focused workspace's row of the last answer that named one; and the workspace row
  // expanded for that focus, null until its row is drawn
  let focus: string | null = null;
  let expanded: string | null = null;

  // An answer that names no focused workspace moves no focus: focus moves to another workspace.
  function followFocus(answer: TreeAnswer) {
    if (answer.focused !== null && answer.focused !== focus) {
      focus = answer.focused;
      const previous = expanded;
      if (previous && !read(touched).has(previous)) update(opened, (rows) => withRow(rows, previous, false));
      expanded = null;
    }
    if (expanded !== null || focus === null) return;
    const id = focus;
    const rows = answer.hosts.flatMap((host) =>
      host.projects.flatMap((project) =>
        project.workspaces.some((workspace) => workspace.id === id) ? [host.id, project.id, id] : [],
      ),
    );
    if (rows.length === 0) return;
    update(opened, (open) => new Set([...open, ...rows]));
    update(touched, (open) => withRow(open, id, false));
    expanded = id;
  }

  function draw(answer: TreeAnswer) {
    followFocus(answer);
    set(tree, answer);
  }

  function ask() {
    cancel = null;
    asking = true;
    again = false;
    plugin
      .request('spyhop.tree', undefined, { signal })
      .then(draw)
      // a failed answer keeps the last tree drawn; the next refresh asks again
      .catch(() => undefined)
      .finally(() => {
        asking = false;
        if (!shown) return;
        if (again) return ask();
        const timer = setTimeout(ask, REFRESH_INTERVAL_MS);
        cancel = () => clearTimeout(timer);
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

  // Orca's id of the focused workspace as `workspace.changed` last reported it: the event also
  // reports the focused workspace's terminals changing, which moves no focus
  let reported: string | null | undefined;
  subscriptions.push(
    on('workspace.changed', ({ context }) => {
      const id = context?.workspaceId ?? null;
      if (id === reported) return;
      reported = id;
      // hidden, the panel asks nothing; shown again, it asks at once
      if (!shown) return;
      if (asking) {
        again = true;
      } else {
        cancel?.();
        ask();
      }
    }),
  );
  signal.addEventListener('abort', () => follow(false));
  refresh = { visible, follow };
}

const totalsText = ({ cost, tokens, premium }: Totals) => `${cost} · ${tokens} tokens · ${premium} premium`;

function cardOf({ id, groups: [identity, ...groups], pane }: CardView) {
  return (
    <Card key={id} title={identity.name.value} description={identity.session?.value}>
      <Stack gap="sm">
        <Badge tone={STATUS_TONES[identity.status.label] ?? 'neutral'}>{identity.status.label}</Badge>
        <KeyValue
          label="IDENTITY"
          items={[
            { label: 'Session', value: identity.session?.value ?? null },
            { label: 'Path', value: identity.path.value },
            { label: 'Branch', value: identity.branch },
            { label: 'Remote', value: identity.remote },
            { label: 'Machine', value: identity.machine },
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
  return (
    <Stack gap="sm">
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
