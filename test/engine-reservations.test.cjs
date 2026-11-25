'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');

const { WORK_KINDS, isWorkKind, workKindError } = loadTs('src/shared/workKind.ts');
const { applyReservations, parseReservations, reservationKey, expiredReservations } = loadTs('src/shared/reservations.ts');
const { pickAgentEntry } = loadTs('src/main/tierPick.ts');
const { resolveAgentWalk } = loadTs('src/shared/modelTiers.ts');
const { ReservationExpiryNotices } = loadTs('src/main/reservationExpiry.ts');
const { planTaskMessage } = loadTs('src/main/taskPatch.ts');

const NOW = Date.parse('2026-11-20T00:00:00Z');
const UNTIL = '2026-11-26T00:00:00Z';
const PAST = '2026-11-19T00:00:00Z';
const codexRes = (extra = {}) => ({ provider: 'codex', kinds: ['splat', 'visual-judgment', 'image-making'], until: UNTIL, ...extra });
const ladder = [{ provider: 'codex', model: 'gpt-6.2-astra' }, { provider: 'claude', model: 'claude-opus-5-5' }];
const run = (entries, reservations, kind, now = NOW) => applyReservations(entries, reservations, kind, now);

test('work kinds are a closed set with a guard', () => {
  assert.deepEqual([...WORK_KINDS], ['code', 'visual-judgment', 'image-making', 'video', 'splat', 'research']);
  assert.equal(isWorkKind('splat'), true);
  assert.equal(isWorkKind('bogus'), false);
  assert.equal(isWorkKind(undefined), false);
});

test('no reservations: list untouched, no notes', () => {
  const r = run(ladder, [], 'code');
  assert.deepEqual(r.list, ladder);
  assert.deepEqual(r.order, [0, 1]);
  assert.equal(r.blocked, undefined);
  assert.deepEqual(r.notes, []);
});

test('an expired reservation does nothing; one expiring exactly now is expired', () => {
  assert.deepEqual(run(ladder, [codexRes({ until: PAST })], 'code').list, ladder);
  assert.deepEqual(run(ladder, [codexRes({ until: new Date(NOW).toISOString() })], 'code').list, ladder);
});

test('a kind mismatch excludes the reserved entry and says why', () => {
  const r = run(ladder, [codexRes()], 'code');
  assert.deepEqual(r.list, [ladder[1]]);
  assert.deepEqual(r.order, [1]);
  assert.match(r.notes.join(' '), /codex reserved until 2026-11-26 for splat, visual-judgment, image-making/);
});

test('an absent kind is not reserved work', () => {
  assert.deepEqual(run(ladder, [codexRes()], undefined).list, [ladder[1]]);
});

test('a kind match keeps the reserved entry and moves it first', () => {
  const claudeFirst = [ladder[1], ladder[0]];
  const r = run(claudeFirst, [codexRes()], 'splat');
  assert.deepEqual(r.list, [ladder[0], ladder[1]]);
  assert.deepEqual(r.order, [1, 0]);
  assert.match(r.notes.join(' '), /preferred/);
});

test('a model-specific reservation leaves other models of the provider alone', () => {
  const entries = [{ provider: 'codex', model: 'gpt-6.2-astra' }, { provider: 'codex', model: 'gpt-6.2-mini' }];
  const r = run(entries, [codexRes({ model: 'gpt-6.2-astra' })], 'code');
  assert.deepEqual(r.list, [entries[1]]);
});

test('a provider-wide reservation removes every model of that provider', () => {
  const entries = [{ provider: 'codex', model: 'a' }, { provider: 'codex', model: 'b' }, { provider: 'claude' }];
  assert.deepEqual(run(entries, [codexRes()], 'code').list, [entries[2]]);
});

test('when everything is reserved the result is blocked naming the reservation, never the reserved engine', () => {
  const r = run([ladder[0]], [codexRes({ note: 'splat week' })], 'code');
  assert.deepEqual(r.list, []);
  assert.match(r.blocked, /codex reserved until 2026-11-26 for splat, visual-judgment, image-making \(splat week\)/);
});

test('an empty input is not blocked', () => {
  assert.equal(run([], [codexRes()], 'code').blocked, undefined);
});

test('parseReservations drops malformed entries and unknown kinds', () => {
  const out = parseReservations([
    codexRes(),
    { provider: 'codex', kinds: ['splat', 'nope'], until: UNTIL },
    { provider: 'codex', kinds: ['splat'], until: 'not a date' },
    { kinds: ['splat'], until: UNTIL },
    'x', null
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[1].kinds, ['splat']);
  assert.deepEqual(parseReservations(undefined), []);
});

test('a reservation with no valid kind still reserves the engine for nobody', () => {
  const out = parseReservations([{ provider: 'codex', kinds: ['nope'], until: UNTIL }]);
  assert.deepEqual(out[0].kinds, []);
  assert.deepEqual(run(ladder, out, 'splat').list, [ladder[1]]);
});

test('a pin beats a reservation that blocks the whole walk', () => {
  const walk = resolveAgentWalk({
    tiers: { strong: [ladder[0]], medium: [], light: [] }, agentTier: 'strong', nowMs: NOW,
    reservations: [codexRes()], kind: 'code'
  });
  assert.ok(walk.blocked, 'the reservation leaves nothing on the walk');
  const pick = pickAgentEntry({ walk, candidateOf: (e) => ({ engine: e.provider, label: e.model }), readings: {}, nowMs: NOW, pin: ladder[0] });
  assert.deepEqual(pick.entry, ladder[0]);
  assert.equal(pick.quotaBlocked, false);
  assert.match(pick.reason, /pinned/);
});

test('expiredReservations returns only those past until', () => {
  const live = codexRes();
  const dead = codexRes({ until: PAST, model: 'm' });
  assert.deepEqual(expiredReservations([live, dead], NOW), [dead]);
  assert.equal(reservationKey(dead), `codex|m|${PAST}`);
});

test('expiry notifies once per reservation and survives a restart through the saved keys', () => {
  const shown = [];
  let saved = [];
  const make = () => new ReservationExpiryNotices(() => true, (t, b) => shown.push([t, b]), () => saved, (keys) => { saved = keys; });
  const dead = codexRes({ until: PAST, note: 'splat week' });
  const first = make();
  first.check([dead], NOW);
  first.check([dead], NOW + 1000);
  assert.equal(shown.length, 1);
  assert.match(shown[0][1], /codex/);
  make().check([dead], NOW + 2000);
  assert.equal(shown.length, 1, 'a fresh instance reads the saved keys');
  make().check([codexRes({ until: PAST, provider: 'claude' })], NOW);
  assert.equal(shown.length, 2, 'a different reservation is its own alert');
});

test('expiry is silent while notifications are off but still marks it seen', () => {
  const shown = [];
  let saved = [];
  let on = false;
  const n = new ReservationExpiryNotices(() => on, (t, b) => shown.push(b), () => saved, (k) => { saved = k; });
  n.check([codexRes({ until: PAST })], NOW);
  on = true;
  n.check([codexRes({ until: PAST })], NOW);
  assert.equal(shown.length, 0);
});

test('a card takes an optional kind validated like difficulty', () => {
  const tasks = [{ id: 'a', title: 'x', status: 'todo', assignee: 'bulb', dependsOn: [] }];
  const boss = (body) => planTaskMessage({ act: 'task-patch', body, sender: 'god', isBoss: true, tasks, now: 'n' });
  assert.match(boss({ id: 'a', kind: 'bogus' }).reason, /kind must be one of code, visual-judgment, image-making, video, splat, research/);
  assert.equal(boss({ id: 'a', kind: 'splat' }).patch.kind, 'splat');
  const cleared = boss({ id: 'a', kind: null });
  assert.ok(cleared.ok && 'kind' in cleared.patch && cleared.patch.kind === undefined);
  const created = planTaskMessage({ act: 'task-create', body: { id: 'n', title: 'x', kind: 'splat' }, sender: 'god', isBoss: true, tasks, now: 'n' });
  assert.equal(created.card.kind, 'splat');
  const worker = planTaskMessage({ act: 'task-patch', body: { id: 'a', kind: 'splat' }, sender: 'bulb', isBoss: false, tasks, now: 'n' });
  assert.equal(worker.ok, false);
});

test('code with a visual check is code work: a visual-reserved engine is never on its ladder', () => {
  const r = run(ladder, [codexRes()], 'code');
  assert.deepEqual(r.list.map((e) => e.provider), ['claude']);
  assert.match(r.notes.join(' '), /excluded/);
});

test('the retired "visual" kind is refused with the split spelled out, never reserved', () => {
  assert.equal(isWorkKind('visual'), false);
  assert.match(workKindError('visual'), /visual-judgment/);
  assert.match(workKindError('visual'), /a visual check is code/i);
  assert.equal(workKindError('code'), undefined);
  assert.deepEqual(parseReservations([{ provider: 'codex', kinds: ['visual'], until: UNTIL }])[0].kinds, []);
  const tasks = [{ id: 'a', title: 'x', status: 'todo', assignee: 'bulb', dependsOn: [] }];
  const r = planTaskMessage({ act: 'task-patch', body: { id: 'a', kind: 'visual' }, sender: 'god', isBoss: true, tasks, now: 'n' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /a visual check is code/i);
});
