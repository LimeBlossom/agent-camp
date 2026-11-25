// Electron-vite builds without type-checking, so a tsc error otherwise reaches integration unseen.
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');

for (const config of ['tsconfig.node.json', 'tsconfig.web.json']) {
  test(`tsc --noEmit -p ${config} is clean`, { timeout: 180000 }, () => {
    const r = spawnSync(process.execPath, [tsc, '--noEmit', '-p', config], { cwd: root, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `${config} type errors:\n${r.stdout}${r.stderr}`);
  });
}
