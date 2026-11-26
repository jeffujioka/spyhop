// What the panel tests find in the drawn panel: the rows of its tree, and the cards' folders.
import type { TestElement, TestPanel } from 'orca/testing';

// The tree's row titled `name`, none when `view` draws no such row.
export const row = (view: TestPanel, name: string) => view.find({ type: 'Collapsible', label: name });
// Whether the row `name`, which `view` draws, is expanded.
export const isOpen = (view: TestPanel, name: string) => view.valueOf(row(view, name)!);

// The folders of the cards `view` draws in `outer`, by their IDENTITY Path.
export function cardFolders(view: TestPanel, outer: TestElement) {
  return view
    .findAll({ type: 'KeyValue', label: 'IDENTITY' })
    .filter((el) => el.path.startsWith(`${outer.path}/`))
    .map((el) => String((el.props.items as { label: string; value: unknown }[]).find((item) => item.label === 'Path')?.value).split('/').pop());
}
