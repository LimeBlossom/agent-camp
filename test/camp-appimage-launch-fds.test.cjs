'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const rmTree = require('../test-support/rm-tree.cjs');

const LOADER = path.join(__dirname, '..', 'test-support', 'load-ts.cjs');
const ELECTRON = require('electron');

// The watchdog runs as Electron-as-Node from the old AppImage mount, and
// Electron holds non-CLOEXEC fds of its own (its V8 snapshot, epoll, eventfd)
// that Node's spawn passes on. Any such fd in the launched Camp pins the old
// mount, so the driver runs under the real Electron binary.
test('launchAppImage passes no fd above 2 to the launched build', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camp-launch-fds-'));
  t.after(() => rmTree(dir));
  const report = path.join(dir, 'fds.txt');
  const stub = path.join(dir, 'Stub.AppImage');
  const argsReport = path.join(dir, 'args.txt');
  fs.writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsReport}"\nls -l /proc/self/fd > "${report}.tmp" && mv "${report}.tmp" "${report}"\n`, { mode: 0o755 });

  const driver = `
    const { launchAppImage } = require(${JSON.stringify(LOADER)})('src/main/campAppImageLaunch.ts');
    launchAppImage(${JSON.stringify(stub)}, ['--camp-restart-token=a b', '$HOME']).then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
  `;
  const parent = spawn(ELECTRON, ['-e', driver], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'inherit', 'inherit']
  });
  const code = await new Promise((resolve) => parent.once('exit', resolve));
  assert.equal(code, 0);

  const deadline = Date.now() + 5000;
  while (!fs.existsSync(report) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  // `ls` holds one fd of its own, on its /proc fd directory; every other fd above 2 leaked.
  const leaked = fs.readFileSync(report, 'utf8').split('\n')
    .map((line) => / (\d+) -> (.*)$/.exec(line)).filter(Boolean)
    .filter(([, fd, target]) => Number(fd) > 2 && !/^\/proc\/\d+\/fd$/.test(target))
    .map(([, fd, target]) => `${fd} -> ${target}`);
  assert.deepEqual(leaked, [], 'the launched build inherited fds from the launcher');
  assert.equal(fs.readFileSync(argsReport, 'utf8'), '--camp-restart-token=a b\n$HOME\n');
});
