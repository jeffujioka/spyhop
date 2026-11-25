// The right-sidebar panel: the tree of Orca host → Orca project → Orca workspace → cards, as the
// worker answers it (src/protocol.ts), asked again every REFRESH_INTERVAL_MS while the panel is
// open and never while it is closed, hidden or unmounted. When the panel opens, the focused Orca
// workspace, its project and its host are expanded and every other row collapsed; from then on
// the rows stay as the developer opens and closes them.
import {
  atom,
  Badge,
  Card,
  Collapsible,
  EmptyState,
  KeyValue,
  plugin,
  read,
  set,
  Spinner,
  Stack,
  type PanelContext,
  type ReadonlyAtom,
  type Tone,
} from 'orca';
import { REFRESH_INTERVAL_MS } from './core/refresh.js';
import type { CardView, TreeAnswer } from './protocol.ts';
import type { Totals } from './tree.ts';

// What the worker answered; null until it does.
const tree = atom<TreeAnswer | null>(null);
// The rows expanded when the panel opened: the focused workspace's, its project's and host's.
const opened = atom<string[]>([]);

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

export function setup({ signal, visible }: PanelContext): void {
  // clears the timer of the next ask; null when none is set
  let cancel: (() => void) | null = null;
  let asking = false;
  let shown = false;

  function draw(answer: TreeAnswer) {
    // the rows of the first answer only: later answers keep the rows as the developer left them
    if (!read(tree)) {
      const rows = answer.hosts.flatMap((host) =>
        host.projects.flatMap((project) =>
          project.workspaces.some((workspace) => workspace.id === answer.focused)
            ? [host.id, project.id, answer.focused!]
            : [],
        ),
      );
      set(opened, rows);
    }
    set(tree, answer);
  }

  function ask() {
    cancel = null;
    asking = true;
    plugin
      .request('spyhop.tree', undefined, { signal })
      .then(draw)
      // a failed answer keeps the last tree drawn; the next refresh asks again
      .catch(() => undefined)
      .finally(() => {
        asking = false;
        if (!shown) return;
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

  signal.addEventListener('abort', () => follow(false));
  refresh = { visible, follow };
}

const totalsText = ({ cost, tokens, premium }: Totals) => `${cost} · ${tokens} tokens · ${premium} premium`;

function cardOf(card: CardView) {
  const [identity, ...groups] = card.groups;
  return (
    <Card key={card.id} title={identity.name.value} description={identity.session?.value}>
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
        <Collapsible key={host.id} title={host.name} defaultOpen={open.includes(host.id)}>
          {host.projects.map((project) => (
            <Collapsible key={project.id} title={project.name} description={totalsText(project.totals)} defaultOpen={open.includes(project.id)}>
              {project.workspaces.map((workspace) => (
                <Collapsible
                  key={workspace.id}
                  title={workspace.name}
                  description={totalsText(workspace.totals)}
                  defaultOpen={open.includes(workspace.id)}
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
