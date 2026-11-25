'use strict';

// Tests-first handoff (alpha-vi024, 11-25): Elm commits red tests on elm/<card>,
// declares testsReady, the Boss reassigns the card to an implementer, who commits the fix
// on that same branch. The implementer's done and the Boss's close must merge it, and a
// close whose merge is skipped must reach the Boss instead of leaving the card silently done.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');
const { mergeRepos } = require('../test-support/merge-repos.cjs');

const { handleHarnessFfMerge } = loadTs('src/main/harnessFfMerge.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { patchCard } = loadTs('src/main/campTools.ts');

const CARD = 'camp-handoff-fix';
const BRANCH = `elm/${CARD}`;
const TESTER = 'elm-mvnvoaig';
const IMPLEMENTER = 'hazel-muh33iy6';
const roster = [
  { id: TESTER, name: 'Elm' },
  { id: IMPLEMENTER, name: 'Hazel' }
];

function git(repo, ...args) {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-C', repo, ...args], { encoding: 'utf8' }).trim();
}
function commit(dir, rel, text) {
  fs.writeFileSync(path.join(dir, rel), text);
  git(dir, 'add', rel);
  git(dir, 'commit', '-qm', rel);
  return git(dir, 'rev-parse', 'HEAD');
}

/** Camp repo on integration; the tester's branch holds red tests, then the implementer's fix. */
function makeFloor(t, { fixed = true, branch = BRANCH } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camp-tests-first-'));
  t.after(() => rmTree(root));
  const repo = path.join(root, 'camp');
  const wt = path.join(root, 'tester-wt');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'integration');
  const base = commit(repo, 'base.txt', 'base\n');
  git(repo, 'worktree', 'add', '-q', '-b', branch, wt, 'integration');
  const testsHead = commit(wt, 'red.test.cjs', 'red\n');
  const tip = fixed ? commit(wt, 'fix.txt', 'fix\n') : testsHead;
  return { root, repo, wt, base, testsHead, tip };
}

const handoffCard = (f, over = {}) => ({
  id: CARD,
  title: 'Camp: handoff fix',
  assignee: IMPLEMENTER,
  status: 'blocked',
  project: 'Camp',
  dependsOn: [],
  createdAt: '2026-11-25T03:00:00.000Z',
  brief: `Fix on ${BRANCH} @ ${f.tip} (worktree ${f.wt}).\n# fail 0`,
  notes: '11-25 hazel: fix committed; awaiting boss merge',
  testsReady: { branch: BRANCH, worktree: f.wt, head: f.testsHead, then: 'handoff', uncovered: 'none', declaredAt: '2026-11-25T02:00:00.000Z' },
  ...over
});
const implementerDone = (f) => ({
  act: 'done',
  to: 'boss',
  subject: `${CARD} done`,
  body: `Fix committed on ${BRANCH} @ ${f.tip} (worktree ${f.wt}).\n# fail 0`
});

test("the implementer's done merges the tester's branch named by the card's testsReady", (t) => {
  const f = makeFloor(t);
  const out = handleHarnessFfMerge(IMPLEMENTER, implementerDone(f), [handoffCard(f)], { repos: mergeRepos({ camp: f.repo }) }, roster);
  assert.equal(out?.ok, true, JSON.stringify(out));
  assert.equal(git(f.repo, 'rev-parse', 'integration'), f.tip);
});

test('another worker branch the card never declared still does not merge', (t) => {
  const f = makeFloor(t, { branch: `elm/other-card` });
  const card = handoffCard(f, { brief: 'b', testsReady: { ...handoffCard(f).testsReady, branch: BRANCH } });
  const msg = { ...implementerDone(f), body: `Reviewed elm/other-card (worktree ${f.wt}).\n# fail 0` };
  const out = handleHarnessFfMerge(IMPLEMENTER, msg, [card], { repos: mergeRepos({ camp: f.repo }) }, roster);
  assert.ok(out === null || out.skipped === true, JSON.stringify(out));
  assert.equal(git(f.repo, 'rev-parse', 'integration'), f.base);
});

async function hiveWith(t, f, card) {
  const home = path.join(f.root, 'home');
  fs.mkdirSync(home);
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  for (const a of roster) await hive.ensureAgent({ ...a, provider: 'claude', cwd: home });
  hive.setFfMergeDeps({ repos: mergeRepos({ camp: f.repo }) });
  hive.writeTasks([card]);
  const close = () => {
    const res = patchCard({
      hiveRoot: path.join(home, 'hive'),
      id: CARD,
      status: 'done',
      result: 'Fix verified.',
      outboxDir: path.join(home, 'hive', 'agents', 'god', 'outbox')
    });
    assert.equal(res.ok, true, res.error);
    hive.routeOnce();
  };
  const rows = () => hive.logTail(500).filter((r) => typeof r.kind === 'string' && r.kind.startsWith('auto-merge') && r.id === CARD);
  const bossMail = () => hive.inbox('god').filter((m) => m.from === 'harness' && /AUTO-MERGE/.test(m.subject || ''));
  return { hive, close, rows, bossMail };
}

test('the Boss closing a tests-first handoff card merges the implementer fix', async (t) => {
  const f = makeFloor(t);
  const h = await hiveWith(t, f, handoffCard(f));
  h.close();
  const rows = h.rows();
  assert.ok(rows.some((r) => r.kind === 'auto-merge' && r.ok), JSON.stringify(rows));
  assert.equal(git(f.repo, 'rev-parse', 'integration'), f.tip);
});

test('a close whose merge is skipped mails the Boss with the branch and reason', async (t) => {
  // Still at the testsReady head: no fix was ever committed, so the close merges nothing.
  const f = makeFloor(t, { fixed: false });
  const h = await hiveWith(t, f, handoffCard(f));
  h.close();
  assert.ok(h.rows().some((r) => r.kind === 'auto-merge-skip'), JSON.stringify(h.rows()));
  const mail = h.bossMail();
  assert.equal(mail.length, 1, JSON.stringify(h.hive.inbox('god').map((m) => m.subject)));
  assert.match(mail[0].subject, new RegExp(CARD));
  assert.match(`${mail[0].subject}\n${mail[0].body}`, new RegExp(BRANCH.replace('/', '\\/')));
  assert.match(mail[0].body, /tests-first handoff/);
  assert.equal(git(f.repo, 'rev-parse', 'integration'), f.base);
});

test('a close skipped because the Boss already merged by hand mails nobody', async (t) => {
  const f = makeFloor(t);
  git(f.repo, 'merge', '-q', '--ff-only', BRANCH);
  const h = await hiveWith(t, f, handoffCard(f));
  h.close();
  assert.ok(h.rows().some((r) => r.kind === 'auto-merge-skip'), JSON.stringify(h.rows()));
  assert.deepEqual(h.bossMail(), []);
});
