'use strict';

// camp-snip-to-card step 5: the snip becomes a card for the boss (assignee god,
// status todo, a guessed valid project, title from the note's first line, the
// snip embedded, context and logs attached), and the boss gets an inform to
// categorize and route it, dormant or not.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const { guessSnipProject, snipCardId, fileSnipCard, SNIP_ATTACH_DIR } = loadTs('src/main/snipCard.ts');

const proj = (name, extra = {}) => ({ name, aliases: [], mentions: [], ...extra });
const PROJECTS = [
  proj('Alpha', { aliases: ['BetaGame'] }),
  proj('GammaGame'),
  proj('DoggosInDungeon'),
  proj('Camp', { aliases: ['munder-difflin'] }),
  proj('Studio', { fallback: true })
];
const { HiveManager } = loadTs('src/main/hive.ts');

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmTree(dir));
  return dir;
}

function repo(dir) { fs.mkdirSync(path.join(dir, '.git'), { recursive: true }); return dir; }

const unity = (projectPath) => ({ window: { title: 'Unity' }, kind: 'unity', unityProject: projectPath, logs: [], errors: [] });

test('a Unity project maps to its game, through aliases, worktrees and subfolders', (t) => {
  const base = tmp(t, 'md-snip-proj-');
  const gt = repo(path.join(base, 'GameDev/BetaGame'));
  const hh = repo(path.join(base, 'GameDev/_Game Jams/GammaGame'));
  const doggos = repo(path.join(base, 'GameDev/DoggosInDungeon'));
  fs.mkdirSync(path.join(doggos, 'UnityProject'), { recursive: true });
  const wt = path.join(base, 'scratch/Beta-cedar');
  fs.mkdirSync(wt, { recursive: true });
  fs.mkdirSync(path.join(gt, '.git/worktrees/Beta-cedar'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(gt, '.git/worktrees/Beta-cedar')}\n`);

  assert.equal(guessSnipProject(unity(gt), PROJECTS), 'Alpha');
  assert.equal(guessSnipProject(unity(wt), PROJECTS), 'Alpha', 'a worktree is its main repo');
  assert.equal(guessSnipProject(unity(hh), PROJECTS), 'GammaGame');
  assert.equal(guessSnipProject(unity(path.join(doggos, 'UnityProject')), PROJECTS), 'DoggosInDungeon');
  assert.equal(guessSnipProject(unity(repo(path.join(base, 'GameDev/MysteryJam'))), PROJECTS), 'Studio');
});

test('Camp is Camp, anything else is Studio, and a guess outside the valid list falls back to Studio', (t) => {
  const gt = repo(path.join(tmp(t, 'md-snip-proj2-'), 'BetaGame'));
  assert.equal(guessSnipProject({ window: {}, kind: 'camp', logs: [], errors: [] }, PROJECTS), 'Camp');
  assert.equal(guessSnipProject({ window: {}, kind: 'other', logs: [], errors: [] }, PROJECTS), 'Studio');
  assert.equal(guessSnipProject(unity(gt), [proj('Camp'), proj('Studio', { fallback: true })]), 'Studio');
  assert.equal(guessSnipProject(unity(gt), ['Camp', 'Studio']), 'Camp', 'with no fallback flag the first project is the fallback');
  assert.equal(guessSnipProject(unity(gt), []), 'General', 'with no projects at all the fallback is General');
  assert.ok(!PROJECTS.some((p) => p.name === 'Inbox'), 'there is no Inbox project to fall back to');
});

test('card ids are the snip time, UTC, to the second', () => {
  assert.equal(snipCardId(new Date('2026-11-19T20:15:02.123Z')), 'snip-20261119-201502');
});

async function floor(t) {
  const home = tmp(t, 'md-snip-file-');
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  return { home, hive };
}

const CONTEXT = {
  window: { id: '0x2', title: 'Main - BetaGame - Unity', wmClass: ['Unity', 'Unity'], pid: 31337, processName: 'Unity', cmdline: 'Unity -projectpath /g/BetaGame' },
  kind: 'unity',
  unityProject: '/g/BetaGame',
  logs: [{ source: '~/.config/unity3d/Editor.log', text: 'NullReferenceException at Foo.cs:12' }],
  errors: []
};
const SNIP = { note: 'Save button does nothing\n\nClicked it twice in the gear menu.', png: Buffer.from('PNGDATA'), context: CONTEXT, now: new Date('2026-11-19T20:15:02Z') };

test('filing writes the attachments and a todo card for the boss', async (t) => {
  const { hive } = await floor(t);
  const out = fileSnipCard(hive, SNIP, { validProjects: PROJECTS, guessProject: () => 'Alpha' });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.cardId, 'snip-20261119-201502');

  const dir = path.join(hive.root(), SNIP_ATTACH_DIR, out.cardId);
  assert.equal(fs.readFileSync(path.join(dir, 'snip.png'), 'utf8'), 'PNGDATA');
  const ctx = JSON.parse(fs.readFileSync(path.join(dir, 'context.json'), 'utf8'));
  assert.equal(ctx.window.title, 'Main - BetaGame - Unity');
  assert.match(fs.readFileSync(path.join(dir, 'logs.txt'), 'utf8'), /Editor\.log[\s\S]*NullReferenceException/);

  const card = hive.tasks().tasks.find((c) => c.id === out.cardId);
  assert.ok(card, 'no card in tasks.json');
  assert.equal(card.assignee, 'god-1');
  assert.equal(card.status, 'todo');
  assert.equal(card.project, 'Alpha');
  assert.equal(card.priority, 'medium');
  assert.equal(card.title, 'Save button does nothing');
  assert.deepEqual(card.dependsOn, []);
  assert.ok(!Number.isNaN(Date.parse(card.createdAt)));
  assert.ok(card.description.includes(`![snip](${path.join(dir, 'snip.png')})`), 'the snip is not embedded');
  assert.match(card.description, /Clicked it twice in the gear menu\./, 'the full note is not in the description');
  assert.match(card.description, /Main - BetaGame - Unity/, 'the app is not named');
  assert.match(card.description, /pid 31337/);
  assert.ok(card.description.includes(path.join(dir, 'context.json')));
  assert.ok(card.description.includes(path.join(dir, 'logs.txt')));
  assert.deepEqual(card.attachments.map((a) => [a.kind, a.path]), [
    ['snip', path.join(dir, 'snip.png')],
    ['context', path.join(dir, 'context.json')],
    ['logs', path.join(dir, 'logs.txt')]
  ]);
});

test('the boss gets an inform to categorize and route, even while dormant', async (t) => {
  const { hive } = await floor(t);
  const out = fileSnipCard(hive, SNIP, { validProjects: PROJECTS });
  const mail = hive.inbox('god-1');
  assert.equal(mail.length, 1);
  assert.equal(mail[0].act, 'inform');
  assert.ok(mail[0].subject.includes(out.cardId), mail[0].subject);
  assert.match(mail[0].body, /project/i);
  assert.match(mail[0].body, /assignee/i);
  assert.match(mail[0].body, /priority/i);
});

test('the project on the card is the guess from the context when none is injected', async (t) => {
  const { hive } = await floor(t);
  const out = fileSnipCard(hive, { ...SNIP, context: { ...CONTEXT, kind: 'camp', unityProject: undefined } }, { validProjects: PROJECTS });
  assert.equal(hive.tasks().tasks.find((c) => c.id === out.cardId).project, 'Camp');
});

test('an empty note still files, titled after the app; no logs means no logs file', async (t) => {
  const { hive } = await floor(t);
  const out = fileSnipCard(hive, { ...SNIP, note: '  ', context: { ...CONTEXT, logs: [] } }, { validProjects: PROJECTS });
  const card = hive.tasks().tasks.find((c) => c.id === out.cardId);
  assert.match(card.title, /Main - BetaGame - Unity/);
  assert.equal(fs.existsSync(path.join(hive.root(), SNIP_ATTACH_DIR, out.cardId, 'logs.txt')), false);
  assert.deepEqual(card.attachments.map((a) => a.kind), ['snip', 'context']);
});

test('two snips in the same second become two cards', async (t) => {
  const { hive } = await floor(t);
  const a = fileSnipCard(hive, SNIP, { validProjects: PROJECTS });
  const b = fileSnipCard(hive, SNIP, { validProjects: PROJECTS });
  assert.equal(a.ok && b.ok, true);
  assert.notEqual(a.cardId, b.cardId);
  assert.equal(hive.tasks().tasks.filter((c) => c.id.startsWith('snip-20261119-201502')).length, 2);
});

test('with no hive there is nothing to file into, and nothing is written', (t) => {
  const hive = new HiveManager(() => null);
  const out = fileSnipCard(hive, SNIP, { validProjects: PROJECTS });
  assert.equal(out.ok, false);
  assert.match(out.error, /hive/i);
});

test('the kanban card shows the snip image, not only its path', () => {
  const kanban = read('src/renderer/src/components/TasksKanban.tsx');
  assert.match(kanban, /attachments/, 'the kanban detail ignores card attachments');
  assert.match(kanban, /<MarkdownPreview[^>]*roots=/, 'no rooted markdown preview to draw a local image');
});
