// How many tasks run at once: `createLimit(count)` returns `limit(task)`, which runs `task()` (a
// function returning a promise) while fewer than `count` of its tasks run, else when one of them
// ends, and settles as the task does. spyhop's own, not copied from herdr-session-stats.
export function createLimit(count) {
  let running = 0;
  const waiting = [];
  function next() {
    if (running >= count || waiting.length === 0) return;
    running += 1;
    waiting.shift()();
  }
  return (task) =>
    new Promise((resolve, reject) => {
      waiting.push(() =>
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            running -= 1;
            next();
          }),
      );
      next();
    });
}
