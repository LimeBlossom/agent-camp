'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const { swapScreenshots, imageLinks } = loadTs('src/main/screenshotSwap.ts');
const { handleCampMcpCall } = loadTs('src/main/campTools.ts');

function hive(t, links, extraQA = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-swap-'));
  t.after(() => rmTree(root));
  const shots = path.join(root, 'agents', 'god', 'shots');
  fs.mkdirSync(shots, { recursive: true });
  const paths = links.map((n) => { const p = path.join(shots, n); fs.writeFileSync(p, `old ${n}`); return p; });
  const q = `**Pick one.** ${paths.map((p, i) => `![s${i}](${p})`).join(' ')}`;
  fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify({ tasks: [{ id: 'c', humanQA: [{ q: 'old ![x](/nope.png)', a: 'done' }, ...extraQA, { q }] }] }));
  const fresh = links.map((n) => { const p = path.join(root, `new-${n}`); fs.writeFileSync(p, `new image ${n}`); return p; });
  return { root, paths, fresh };
}
const now = () => new Date('2026-11-06T05:00:00Z');

for (const restoreCode of ['EIO', 'ENOSPC']) {
  for (const entryPoint of ['helper', 'camp tool']) {
    test(`${entryPoint} preserves recovery bytes and reports rollback failure when restore keeps failing with ${restoreCode}`, (t) => {
      const { root, paths, fresh } = hive(t, ['a.png', 'b.png']);
      const original = fs.readFileSync(paths[0]);
      const shots = path.dirname(paths[0]);
      const older = path.join(shots, 'a.prev-older.png');
      fs.writeFileSync(older, 'unrelated older backup');
      let copyFailed = false;
      let changedBeforeFailure = false;
      let restoreFailures = 0;
      const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
      const intercept = (name, destinationIndex) => {
        const real = fs[name];
        return t.mock.method(fs, name, (...args) => {
          const destination = String(args[destinationIndex]);
          if (copyFailed && destination === paths[0]) {
            restoreFailures++;
            return fail(restoreCode, `injected persistent ${restoreCode} restoring ${destination}`);
          }
          if (name === 'copyFileSync' && String(args[0]) === fresh[1]) {
            changedBeforeFailure = !fs.readFileSync(paths[0]).equals(original);
            copyFailed = true;
            return fail('EIO', 'injected second-image copy EIO');
          }
          return real(...args);
        });
      };
      const mocks = [intercept('copyFileSync', 1), intercept('writeFileSync', 0), intercept('renameSync', 1)];
      let result;
      try {
        result = entryPoint === 'helper'
          ? swapScreenshots({ hiveRoot: root, cardId: 'c', images: fresh, now })
          : handleCampMcpCall('swap_screenshots', { card_id: 'c', images: fresh }, { hiveRoot: root, agentId: 'god' });
      } finally {
        for (const mock of mocks) mock.mock.restore();
      }
      assert.ok(copyFailed && changedBeforeFailure, 'failure must occur after the first destination changed');
      assert.ok(restoreFailures > 0, 'must exercise persistently failing restoration');
      assert.equal(entryPoint === 'helper' ? result.ok : !result.isError, false);
      assert.equal(fs.readFileSync(older, 'utf8'), 'unrelated older backup');
      const recoveryPaths = fs.readdirSync(shots)
        .map((name) => path.join(shots, name))
        .filter((file) => file !== paths[0] && fs.readFileSync(file).equals(original));
      const report = entryPoint === 'helper' ? JSON.stringify(result) : result.content.map((c) => c.text || '').join('\n');
      assert.deepEqual({
        recoverable: recoveryPaths.length > 0,
        explicitRollbackFailure: /rollback|restor/i.test(report),
        reportsRecoveryPath: recoveryPaths.some((file) => report.includes(file))
      }, { recoverable: true, explicitRollbackFailure: true, reportsRecoveryPath: true }, report);
      assert.deepEqual(fresh.map((file) => fs.readFileSync(file, 'utf8')), ['new image a.png', 'new image b.png']);
    });
  }
}

test('imageLinks reads markdown image targets in order', () => {
  assert.deepEqual(imageLinks('a ![x](/p/1.png) b ![](/p/2.jpg) [link](/p/3.png)'), ['/p/1.png', '/p/2.jpg']);
});

test('new images land on the embedded paths, the old ones are kept, every link checks out', (t) => {
  const { root, paths, fresh } = hive(t, ['a.png', 'b.png']);
  const r = swapScreenshots({ hiveRoot: root, cardId: 'c', images: [fresh[0]], now });
  assert.equal(r.ok, true, r.error);
  assert.equal(fs.readFileSync(paths[0], 'utf8'), 'new image a.png');
  assert.equal(fs.readFileSync(paths[1], 'utf8'), 'old b.png', 'only the first link was given a new image');
  assert.equal(fs.readFileSync(r.swapped[0].keptOld, 'utf8'), 'old a.png');
  assert.match(r.swapped[0].keptOld, /a\.prev-20261106050000\.png$/);
  assert.deepEqual(r.links.map((l) => l.ok), [true, true]);
});

test('refuses more images than links, a missing source, and links outside the hive', (t) => {
  const { root, fresh } = hive(t, ['a.png']);
  assert.match(swapScreenshots({ hiveRoot: root, cardId: 'c', images: [fresh[0], fresh[0]] }).error, /embeds 1 image/);
  assert.match(swapScreenshots({ hiveRoot: root, cardId: 'c', images: ['/no/such.png'] }).error, /not found/);
  assert.match(swapScreenshots({ hiveRoot: root, cardId: 'x', images: [fresh[0]] }).error, /no card x/);
  const out = hive(t, ['a.png']);
  const tasks = JSON.parse(fs.readFileSync(path.join(out.root, 'tasks.json'), 'utf8'));
  tasks.tasks[0].humanQA.push({ q: '**Q.** ![o](/etc/hostname)' });
  fs.writeFileSync(path.join(out.root, 'tasks.json'), JSON.stringify(tasks));
  assert.match(swapScreenshots({ hiveRoot: out.root, cardId: 'c', images: [out.fresh[0]] }).error, /outside it/);
});

test('the camp tool reports a broken link it cannot fix and leaves destinations unmutated', (t) => {
  const { root, paths, fresh } = hive(t, ['a.png', 'b.png']);
  fs.rmSync(paths[1]);
  const res = handleCampMcpCall('swap_screenshots', { card_id: 'c', images: [fresh[0]] }, { hiveRoot: root, agentId: 'god' });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /broken image link/);
  assert.equal(fs.readFileSync(paths[0], 'utf8'), 'old a.png', 'original destination must survive failed tool call');
});

test('original destinations survive failed whole-operation validation without partial mutations', (t) => {
  const { root, paths, fresh } = hive(t, ['a.png', 'b.png']);
  fs.rmSync(paths[1]);
  const r = swapScreenshots({ hiveRoot: root, cardId: 'c', images: [fresh[0]], now });
  assert.equal(r.ok, false);
  assert.match(r.error, /broken image link/);
  assert.equal(fs.readFileSync(paths[0], 'utf8'), 'old a.png', 'target path must remain intact when operation fails validation');
  const keptOld = path.join(path.dirname(paths[0]), 'a.prev-20261106050000.png');
  assert.equal(fs.existsSync(keptOld), false, 'no keptOld mutation when whole operation fails');
});

test('collision handling does not clobber existing backup files and preserves destinations on failure', (t) => {
  const { root, paths, fresh } = hive(t, ['a.png']);
  const collisionPath = path.join(path.dirname(paths[0]), 'a.prev-20261106050000.png');
  fs.writeFileSync(collisionPath, 'previous-unrelated-backup');
  const r = swapScreenshots({ hiveRoot: root, cardId: 'c', images: [fresh[0]], now });
  // If the collision makes it fail, destination must survive; if it handles collision, existing backup must not be overwritten
  assert.equal(fs.readFileSync(collisionPath, 'utf8'), 'previous-unrelated-backup', 'existing backup must never be clobbered by collision');
  if (!r.ok) {
    assert.equal(fs.readFileSync(paths[0], 'utf8'), 'old a.png', 'original destination survives on failure');
  }
});

for (const entryPoint of ['helper', 'camp tool']) {
  test(`${entryPoint} preserves all destination and backup bytes after a second-image copy I/O failure`, (t) => {
    const { root, paths, fresh } = hive(t, ['a.png', 'b.png']);
    const shots = path.dirname(paths[0]);
    fs.writeFileSync(path.join(shots, 'a.prev-older.png'), 'older backup A\n');
    fs.writeFileSync(path.join(shots, 'b.prev-older.png'), 'older backup B\n');
    const snapshot = () => Object.fromEntries(fs.readdirSync(shots).sort().map((name) => [name, fs.readFileSync(path.join(shots, name))]));
    const before = snapshot();
    const copyFileSync = fs.copyFileSync;
    let injected = false;
    let earlierDestinationChanged = false;
    const mock = t.mock.method(fs, 'copyFileSync', (source, destination, ...args) => {
      if (String(source) === fresh[1]) {
        injected = true;
        earlierDestinationChanged = !fs.readFileSync(paths[0]).equals(before['a.png']);
        const error = new Error('injected second-image copy failure');
        error.code = 'EIO';
        throw error;
      }
      return copyFileSync(source, destination, ...args);
    });
    let result;
    let thrown;
    try {
      result = entryPoint === 'helper'
        ? swapScreenshots({ hiveRoot: root, cardId: 'c', images: fresh, now })
        : handleCampMcpCall('swap_screenshots', { card_id: 'c', images: fresh }, { hiveRoot: root, agentId: 'god' });
    } catch (error) {
      thrown = error;
    } finally {
      mock.mock.restore();
    }
    assert.ok(injected, 'must reach actual second-image copy rather than fail fixture validation');
    if (thrown) assert.match(thrown.message, /injected second-image copy failure/);
    else if (entryPoint === 'helper') assert.equal(result.ok, false);
    else assert.equal(result.isError, true);
    assert.deepEqual(snapshot(), before,
      `failed copy must preserve every destination and backup; earlier destination changed before EIO: ${earlierDestinationChanged}`);
    assert.deepEqual(fresh.map((file) => fs.readFileSync(file, 'utf8')), ['new image a.png', 'new image b.png']);
  });
}
