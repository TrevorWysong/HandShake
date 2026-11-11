// The first thing a packaged app's main process runs -- imported ahead of
// everything else in Kangaroo's entry (build.ts): it won't start with a way
// for another program to drive it.
//
// The build's fuses (build.ts, `electronFuses`) already ignore Node's own
// ways in: --inspect and its kin, NODE_OPTIONS, and running as plain Node.
// Chromium's debugging switches aren't Node's, and no fuse covers them: one
// would let any program on the machine read the key window's page
// (paymentKeys.ts) as keys are typed, or call the payment commands as the
// app's page. A packaged app given one quits before any window opens.
// While developing (`build.ts dev`), they're left to work.
import { app } from 'electron';

const DEBUGGING = ['remote-debugging-port', 'remote-debugging-pipe', 'remote-allow-origins', 'inspect', 'inspect-brk', 'inspect-port'];

const given = DEBUGGING.filter((name) => app.commandLine.hasSwitch(name));
if (app.isPackaged && given.length > 0) {
  console.error(`Refusing to start with --${given.join(', --')}: a packaged HandShake can't be debugged from outside.`);
  process.exit(1);
}
