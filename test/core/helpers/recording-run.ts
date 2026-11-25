// The real runner (src/exec.ts), recording each call with its options. `answer` stands in for
// what cannot run beside the test, such as a remote host: a call it answers (a result, not
// undefined) is not run here.
import { run, type Run, type RunOptions, type RunResult } from '../../../src/exec.ts';

type Answer = (command: string, args: string[], options: RunOptions) => Promise<RunResult> | undefined;

export function recordingRun(answer: Answer = () => undefined) {
  const calls: { command: string; args: string[]; options: RunOptions }[] = [];
  const exec: Run = (command, args, options = {}) => {
    calls.push({ command, args, options });
    return answer(command, args, options) ?? run(command, args, options);
  };
  return { exec, calls };
}
