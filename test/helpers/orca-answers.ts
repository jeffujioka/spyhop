// Orca's ids and the recorded answers the tests give the `orca` stand-in
// (test/helpers/stand-ins.ts), shaped on this Mac's Orca: `orca host list` and
// `orca environment list` with the SSH target `devbox` and with the paired server `jeff`.
import { answer } from './stand-ins.ts';

// Orca's ids, as `orca host list` and `orca environment list` give them on this Mac: of the SSH
// targets `devbox` and `jeff`, and of the paired server's environment.
export const DEVBOX = 'ssh-1795031810693-d3v8ox';
export const JEFF_TARGET = 'ssh-1795031810693-tsad3q';
export const JEFF_ENV = 'dc9a64c1-6450-46a1-a62c-9b03d06b187a';

// Rows of `orca host list`: this computer, and the SSH target `devbox`.
export const LOCAL_HOST = { kind: 'local', name: 'this machine', id: 'local', selector: '--host local' };
export const DEVBOX_HOST = { kind: 'ssh', name: 'devbox', id: DEVBOX, selector: `--host ssh:${DEVBOX}`, connected: true };

// What `orca host list --json` answers with the rows `hosts`, and `orca environment list --json`
// with `environments`.
export const hostListOf = (...hosts: object[]) => answer({ hosts });
export const environmentListOf = (...environments: object[]) => answer({ environments });

// The two lists when the SSH target `devbox` is the only other Orca host.
export const DEVBOX_LISTS = { 'host list --json': hostListOf(DEVBOX_HOST), 'environment list --json': environmentListOf() };

// The two lists when the paired server `jeff`, reached as the ssh alias `jeff`, is the only other
// Orca host, and the command lines that list its agents and its terminals.
export const JEFF_LISTS = {
  'host list --json': hostListOf(LOCAL_HOST),
  'environment list --json': environmentListOf({ id: JEFF_ENV, name: 'jeff', connectionDependency: 'ssh-tunnel' }),
};
export const JEFF_AGENT_LIST = 'agent list --environment jeff --json';
export const JEFF_TERMINAL_LIST = 'terminal list --environment jeff --json';

// `orca environment list --json` with the paired server named `jeff-server`, deployed over the
// SSH target `jeff`.
export const JEFF_SERVER_ENVIRONMENTS = environmentListOf({
  id: JEFF_ENV,
  name: 'jeff-server',
  connectionDependency: 'ssh-tunnel',
  orcadDeployment: { sshTargetId: JEFF_TARGET, sshTargetGeneration: 8, localPort: 56082, remotePort: 6768 },
});
