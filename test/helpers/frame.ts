// Orca's Frame API as an HTML panel sees it (`plugin.request`, `plugin.on`, `on('theme')`; see
// "Frame API" in Orca's plugin guide), played over the real worker the test kit mounts: a request
// goes to the worker's handler, and what the worker posts with `orca.panels.post` is handed to the
// `plugin.on` handlers, in order, as soon as it is posted while a request of the frame is out, and
// before that request's answer, as Orca hands a frame both down one channel. The test kit hands a
// frame none of the worker's posts, so this does. `post` hands the handlers a post as Orca would,
// as the test kit's `TestPanel.post` does for a components panel; `emitTheme`: Orca's theme changed.
// A hand-written peer of a published interface, not a test double.
import { setImmediate } from 'node:timers/promises';
import type { TestWorker } from 'orca/testing';
import type { Frame } from '../../src/live/controller.ts';

type Handler = (payload: never) => void;

export function frameOf(worker: TestWorker) {
  const handlers = new Map<string, Set<Handler>>();
  const themes = new Set<(theme: { colorScheme: 'light' | 'dark' }) => void>();
  // how many of the worker's posts the handlers have been handed
  let handed = worker.posts.length;

  function post(event: string, payload?: unknown) {
    for (const handler of handlers.get(event) ?? []) handler(payload as never);
  }
  // Hands on what the worker posted since the last time.
  function handOn() {
    for (; handed < worker.posts.length; handed += 1) post(worker.posts[handed].event, worker.posts[handed].payload);
  }

  async function request(name: string, input?: unknown) {
    let out = true;
    const answering = (worker.request as (name: string, input?: unknown) => Promise<unknown>)(name, input);
    const ended = () => {
      out = false;
    };
    answering.then(ended, ended);
    // the worker posts while it builds; each turn of the loop hands on what it posted so far
    while (out) {
      handOn();
      await setImmediate();
    }
    handOn();
    return answering;
  }

  function on(event: string, handler: Handler) {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event)!.add(handler);
    return { dispose: () => handlers.get(event)!.delete(handler) };
  }

  const frame: Frame = {
    plugin: { request: request as Frame['plugin']['request'], on: on as Frame['plugin']['on'] },
    on(event: 'theme', handler: () => void) {
      themes.add(handler);
      return { dispose: () => themes.delete(handler) };
    },
  };
  return Object.assign(frame, {
    post,
    emitTheme(colorScheme: 'light' | 'dark') {
      for (const handler of themes) handler({ colorScheme });
    },
  });
}
