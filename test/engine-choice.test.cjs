'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');

const { chooseEngine, parseEngineList, tighter, ENGINE_FULL_PERCENT } = loadTs('src/main/engineChoice.ts');
const all = () => true;

test('parseEngineList knows the four engines, drops unknowns and repeats', () => {
  assert.deepEqual(parseEngineList(['agy', 'Codex', 'bogus', 'antigravity', 'agy-claude', 'claude']), ['agy', 'codex', 'agy-claude', 'claude']);
  assert.deepEqual(parseEngineList('agy'), []);
});

test('the first engine with room wins', () => {
  const c = chooseEngine(['agy', 'codex', 'claude'], { agy: 20, codex: 10, claude: 5 }, all);
  assert.equal(c.engine.id, 'agy');
});

test('a full engine is skipped and named in the reason', () => {
  const c = chooseEngine(['agy', 'codex', 'claude'], { agy: ENGINE_FULL_PERCENT, codex: 40 }, all);
  assert.equal(c.engine.id, 'codex');
  assert.match(c.reason, /skipped agy 85% used/);
});

test('an engine with no reading counts as having room', () => {
  assert.equal(chooseEngine(['codex', 'claude'], { claude: 0 }, all).engine.id, 'codex');
});

test('when everything is full the least used engine is taken', () => {
  const c = chooseEngine(['agy', 'codex', 'claude'], { agy: 99, codex: 90, claude: 95 }, all);
  assert.equal(c.engine.id, 'codex');
  assert.match(c.reason, /least used/);
});

test('engines that are not installed are never picked', () => {
  assert.equal(chooseEngine(['agy', 'codex'], {}, (p) => p === 'codex').engine.id, 'codex');
  assert.equal(chooseEngine(['agy'], {}, () => false), null);
});

test('tighter takes the higher percent and ignores missing windows', () => {
  assert.equal(tighter(12, 73), 73);
  assert.equal(tighter(undefined, 40), 40);
  assert.equal(tighter(undefined, undefined), undefined);
});

test('agy-claude is its own engine with its own pool, on a Claude model', () => {
  const c = chooseEngine(['agy', 'agy-claude', 'codex'], { agy: 92, 'agy-claude': 10 }, all);
  assert.equal(c.engine.id, 'agy-claude');
  assert.equal(c.engine.provider, 'antigravity');
  assert.match(c.engine.model, /^claude-/);
});

// Persistent agents: balanceEngines over an agent's own model list.
const { balanceEngines, readEngine, engineFor, HEADROOM_MARGIN, RESET_SOON_MS } = loadTs('src/main/engineChoice.ts');
const { entryExclusion, cleanModelList } = loadTs('src/shared/modelBalance.ts');
const NOW = 1_800_000_000_000;
const cand = (engine, label = engine) => ({ engine, label });

test('balance: the preferred entry keeps the agent while it is not much more used', () => {
  const r = balanceEngines([cand('claude'), cand('codex')], { claude: { percent: 50 }, codex: { percent: 30 } }, NOW);
  assert.equal(r.index, 0);
});

test('balance: a later entry with HEADROOM_MARGIN more room takes over, and says why', () => {
  const r = balanceEngines([cand('claude'), cand('codex')], { claude: { percent: 70 }, codex: { percent: 70 - HEADROOM_MARGIN } }, NOW);
  assert.equal(r.index, 1);
  assert.match(r.reason, /preferred claude 70% used paces 30 points higher/);
});

test('balance: a full entry is skipped even when it is first', () => {
  const r = balanceEngines([cand('codex'), cand('claude')], { codex: { percent: ENGINE_FULL_PERCENT }, claude: { percent: 60 } }, NOW);
  assert.equal(r.index, 1);
  assert.match(r.reason, /skipped codex 85% used/);
});

test('balance: entries without a reading are never compared, so order decides', () => {
  assert.equal(balanceEngines([cand(undefined, 'grok/default'), cand('claude')], { claude: { percent: 0 } }, NOW).index, 0);
});

test('balance: when every entry is full the one that resets soonest wins', () => {
  const r = balanceEngines([cand('claude'), cand('codex'), cand('agy')], {
    claude: { percent: 90, roomAtMs: NOW + 3 * 3_600_000 },
    codex: { percent: 99, roomAtMs: NOW + 40 * 60_000 },
    agy: { percent: 86 }
  }, NOW);
  assert.equal(r.index, 1);
  assert.match(r.reason, /resets soonest \(room in 40m\)/);
});

test('balance: a one-entry list returns that entry whatever its usage', () => {
  assert.equal(balanceEngines([cand('codex')], { codex: { percent: 100, roomAtMs: NOW + 1e9 } }, NOW).index, 0);
  assert.equal(balanceEngines([cand('codex')], {}, NOW).index, 0);
  assert.equal(balanceEngines([], {}, NOW), null);
});

test('readEngine: tighter window, with a window resetting soon reading empty', () => {
  assert.deepEqual(readEngine([{ percent: 20 }, { percent: 60 }], NOW), { percent: 60, pace: 60, lockoutMs: 0 });
  assert.deepEqual(readEngine([{ percent: 95, resetsAtMs: NOW + RESET_SOON_MS - 1 }, { percent: 40 }], NOW), { percent: 40, pace: 40, lockoutMs: 0 });
  assert.deepEqual(readEngine([{ percent: 95, resetsAtMs: NOW - 1 }], NOW), { percent: 0, pace: 0, lockoutMs: 0 });
  assert.deepEqual(readEngine([{ percent: 95, resetsAtMs: NOW + 3_600_000 }, { percent: 90, resetsAtMs: NOW + 7_200_000 }], NOW),
    { percent: 95, pace: 95, lockoutMs: 0, roomAtMs: NOW + 7_200_000 });
  assert.deepEqual(readEngine([undefined], NOW), {});
});

// Pace: projected percent at reset, so windows of different lengths compare fairly.
const { projectedPercent, limitSwitchPick, PACE_MIN_ELAPSED, FIVE_HOURS_MS, SEVEN_DAYS_MS } = loadTs('src/main/engineChoice.ts');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A window `elapsedMs` into its length, `percent` used. */
const win = (percent, lengthMs, elapsedMs) => ({ percent, lengthMs, resetsAtMs: NOW + lengthMs - elapsedMs });

test('pace: percent over the share of the window elapsed', () => {
  assert.equal(projectedPercent(win(68, SEVEN_DAYS_MS, 3.5 * DAY), NOW), 136);
  assert.equal(projectedPercent(win(38, FIVE_HOURS_MS, 4 * HOUR), NOW), 47.5);
  assert.equal(projectedPercent(win(50, SEVEN_DAYS_MS, 7 * DAY), NOW), 50, 'at the end of the window pace is the real percent');
});

test('pace: early in a window the elapsed share is floored, so one minute in cannot project absurdly', () => {
  assert.equal(PACE_MIN_ELAPSED, 0.1);
  assert.equal(projectedPercent(win(1, FIVE_HOURS_MS, 60_000), NOW), 10, 'not the 300% a straight projection gives');
  assert.equal(projectedPercent(win(20, FIVE_HOURS_MS, 12 * 60_000), NOW), 200);
  assert.equal(projectedPercent(win(10, FIVE_HOURS_MS, 0), NOW), 100);
  assert.equal(projectedPercent({ percent: 10, lengthMs: FIVE_HOURS_MS, resetsAtMs: NOW + 2 * FIVE_HOURS_MS }, NOW), 100,
    'a reset further off than the window is long reads as just started');
  assert.equal(projectedPercent(win(30, FIVE_HOURS_MS, 30 * 60_000), NOW), 300, 'the floor ends a tenth of the way in: 30 min of 5h');
  assert.ok(Math.abs(projectedPercent(win(30, FIVE_HOURS_MS, 60 * 60_000), NOW) - 150) < 1e-9, 'past it, the straight projection');
});

test('pace: an unknown window length or reset time falls back to the real percent', () => {
  assert.equal(projectedPercent({ percent: 40, resetsAtMs: NOW + HOUR }, NOW), 40);
  assert.equal(projectedPercent({ percent: 40, lengthMs: FIVE_HOURS_MS }, NOW), 40);
  const r = readEngine([{ percent: 40, resetsAtMs: NOW + HOUR }, win(10, SEVEN_DAYS_MS, 6 * DAY)], NOW);
  const { pace, unusedPerHour, ...rest } = r;
  assert.ok(Math.abs(unusedPerHour - (100 - pace) / 24) < 1e-9);
  assert.deepEqual(rest, { percent: 40, rankPercent: 10, rankWindow: '7d', paceWindow: '7d', lockoutMs: 0, resetInMs: DAY },
    'the 7d ranks; the unknown window only holds the full skip at its raw 40%');
  assert.ok(Math.abs(pace - 10 / (6 / 7)) < 1e-9);
  const why = balanceEngines([cand('codex')], { codex: r }, NOW).reason;
  assert.equal(why, 'codex 10% of 7d, 40% on a window of unknown length, pace 12%, no lockout');
  const raw = readEngine([{ percent: 40, resetsAtMs: NOW + HOUR }], NOW);
  assert.match(balanceEngines([cand('codex')], { codex: raw }, NOW).reason, /codex 40% used, pace 40% \(raw, window length unknown\), no lockout/);
});

test('pace: windows of different lengths compare by pace, not raw percent', () => {
  // A 7d window at 68% halfway through paces 136%; a 5h window at 38% four hours in paces 47.5%.
  // Raw, the preferred entry is 30 points more used; by pace it is 88.5 points hotter.
  const readings = {
    codex: readEngine([win(10, FIVE_HOURS_MS, 4 * HOUR), win(68, SEVEN_DAYS_MS, 3.5 * DAY)], NOW),
    'agy-claude': readEngine([win(38, FIVE_HOURS_MS, 4 * HOUR), win(5, SEVEN_DAYS_MS, 3.5 * DAY)], NOW)
  };
  const r = balanceEngines([cand('codex', 'codex/gpt-6.1-sol'), cand('agy-claude', 'antigravity/Claude Opus 4.6 (Thinking)')], readings, NOW);
  assert.equal(r.index, 1);
  assert.equal(r.reason, 'antigravity/Claude Opus 4.6 (Thinking) 5% of 7d, 5h 38%, pace 10%, no lockout; preferred codex/gpt-6.1-sol 68% of 7d, pace 136%, lockout ~1.9d: ~1.9d longer lockout');

  // A hot 5h (38% one hour in, 190%) no longer counts against agy-claude: only the 7d
  // paces compare (87% against 14%), so it takes over.
  const late = {
    codex: readEngine([win(5, FIVE_HOURS_MS, 4 * HOUR), win(68, SEVEN_DAYS_MS, 5.5 * DAY)], NOW),
    'agy-claude': readEngine([win(38, FIVE_HOURS_MS, HOUR), win(2, SEVEN_DAYS_MS, DAY)], NOW)
  };
  const moved = balanceEngines([cand('codex', 'codex/gpt-6.1-sol'), cand('agy-claude', 'agy-claude')], late, NOW);
  assert.equal(moved.index, 1);
  assert.equal(moved.reason, 'agy-claude 2% of 7d, 5h 38%, pace 14%, no lockout; preferred codex/gpt-6.1-sol 68% of 7d, pace 87%, no lockout paces 73 points higher');
  // Half a day from codex's reset, its unused 32% outranks agy-claude's slow week.
  late.codex = readEngine([win(5, FIVE_HOURS_MS, 4 * HOUR), win(68, SEVEN_DAYS_MS, 6.5 * DAY)], NOW);
  assert.equal(balanceEngines([cand('codex'), cand('agy-claude')], late, NOW).index, 0);
});

test('pace: a fast 5h does not set the pace when a 7d window is known', () => {
  const r = readEngine([win(40, FIVE_HOURS_MS, HOUR + 15 * 60_000), win(60, SEVEN_DAYS_MS, 6 * DAY)], NOW);
  assert.equal(r.window, '7d');
  assert.equal(r.paceWindow, '7d');
  assert.equal(r.pace, 70, 'the 7d pace, not the 5h 160%');
  assert.match(balanceEngines([cand('claude')], { claude: r }, NOW).reason, /^claude 60% of 7d, pace 70%, no lockout$/);
  const noWeek = readEngine([win(40, FIVE_HOURS_MS, HOUR + 15 * 60_000), { percent: 60 }], NOW);
  assert.equal(noWeek.paceWindow, '5h', 'the only sized window sets pace when no 7d is known');
});

test('weekly first: Sol low on 5h but fast on 7d loses to Claude high on 5h but slow on 7d', () => {
  const readings = {
    codex: readEngine([win(10, FIVE_HOURS_MS, 4 * HOUR), win(60, SEVEN_DAYS_MS, 3 * DAY)], NOW),
    claude: readEngine([win(80, FIVE_HOURS_MS, 2 * HOUR), win(20, SEVEN_DAYS_MS, 3 * DAY)], NOW)
  };
  const r = balanceEngines([cand('codex', 'codex/gpt-6.1-sol'), cand('claude')], readings, NOW);
  assert.equal(r.index, 1);
  assert.match(r.reason, /^claude 20% of 7d, 5h 80%, pace 47%, no lockout; preferred codex\/gpt-6\.1-sol 60% of 7d, pace 140%, lockout ~2\.0d/);
  const c = chooseEngine(['codex', 'claude'], readings, all);
  assert.equal(c.engine.id, 'claude', 'temporary workers follow the 7d lockout too');
});

test('weekly first: an engine whose 5h is full is skipped however much 7d it has left', () => {
  const readings = {
    claude: readEngine([win(ENGINE_FULL_PERCENT, FIVE_HOURS_MS, 2 * HOUR), win(5, SEVEN_DAYS_MS, 3 * DAY)], NOW),
    codex: readEngine([win(10, FIVE_HOURS_MS, 4 * HOUR), win(70, SEVEN_DAYS_MS, 3 * DAY)], NOW)
  };
  const r = balanceEngines([cand('claude'), cand('codex')], readings, NOW);
  assert.equal(r.index, 1);
  assert.match(r.reason, /skipped claude 5% of 7d, 5h 85%/);
  assert.equal(chooseEngine(['claude', 'codex'], readings, all).engine.id, 'codex');
});

test('weekly first: equal 7d readings keep the preferred entry', () => {
  const same = () => readEngine([win(50, FIVE_HOURS_MS, HOUR), win(30, SEVEN_DAYS_MS, 3 * DAY)], NOW);
  const r = balanceEngines([cand('codex'), cand('claude')], { codex: same(), claude: readEngine([win(5, FIVE_HOURS_MS, HOUR), win(30, SEVEN_DAYS_MS, 3 * DAY)], NOW) }, NOW);
  assert.equal(r.index, 0, 'a quieter 5h alone does not move the agent');
});

test('pace: the full skip, roomAtMs and the fallbacks stay on real percent', () => {
  // 86% of a 7d window 2 days from reset paces 120%; a 5h window at 30% 15 minutes in paces 300%.
  // Pace would rank the first lower, but it is still skipped as nearly out.
  const readings = {
    claude: readEngine([win(86, SEVEN_DAYS_MS, 5 * DAY)], NOW),
    codex: readEngine([win(30, FIVE_HOURS_MS, 15 * 60_000)], NOW)
  };
  assert.equal(readings.claude.percent, 86);
  assert.ok(readings.claude.pace < readings.codex.pace);
  const r = balanceEngines([cand('claude'), cand('codex')], readings, NOW);
  assert.equal(r.index, 1);
  assert.match(r.reason, /skipped claude 86% of 7d/);
  assert.equal(readings.claude.roomAtMs, NOW + 2 * DAY);
  // 20 minutes from its reset the same 86% projects no lockout, so it is spent, not skipped.
  const last = readEngine([win(86, SEVEN_DAYS_MS, 7 * DAY - 20 * 60_000 - 1)], NOW);
  assert.equal(last.spendBeforeReset, true);
  assert.equal(last.roomAtMs, undefined);
  assert.equal(balanceEngines([cand('codex'), cand('claude')], { ...readings, claude: last }, NOW).index, 1);

  // A slow-paced window at 90% does not dodge the all-full fallback either: least-used is real percent.
  const full = {
    claude: readEngine([win(90, SEVEN_DAYS_MS, 5 * DAY)], NOW),
    codex: readEngine([win(88, SEVEN_DAYS_MS, DAY)], NOW)
  };
  assert.ok(full.claude.pace < full.codex.pace);
  assert.equal(limitSwitchPick([cand('claude'), cand('codex')], full, NOW).index, 1, 'least used by real percent');
  assert.equal(balanceEngines([cand('claude'), cand('codex')], full, NOW).index, 0, 'soonest reset, not pace');
});

test('pace: a window resetting soon reads 0 for pace as well as percent', () => {
  const r = readEngine([win(80, FIVE_HOURS_MS, FIVE_HOURS_MS - RESET_SOON_MS + 1), win(10, SEVEN_DAYS_MS, 6 * DAY)], NOW);
  assert.equal(r.percent, 10);
  assert.ok(Math.abs(r.pace - 10 / (6 / 7)) < 1e-9);
});

test('chooseEngine takes full readings and shows pace in its reason', () => {
  const c = chooseEngine(['codex', 'claude'], { codex: readEngine([win(90, SEVEN_DAYS_MS, 6 * DAY)], NOW), claude: 10 }, all);
  assert.equal(c.engine.id, 'claude');
  assert.match(c.reason, /skipped codex 90% of 7d, pace 105%/);
});

test('engineFor maps agy models onto their pools', () => {
  assert.equal(engineFor('antigravity'), 'agy');
  assert.equal(engineFor('antigravity', 'Gemini 3.1 Pro (High)'), 'agy');
  assert.equal(engineFor('antigravity', 'Claude Opus 4.6 (Thinking)'), 'agy-claude');
  assert.equal(engineFor('antigravity', 'Gemini 4 Argon (Medium)'), 'agy-argon');
  assert.equal(engineFor('antigravity', 'gemini-4-argon-medium'), 'agy-argon');
  assert.equal(engineFor('codex', 'gpt-6-luna'), 'codex');
  assert.equal(engineFor('grok'), undefined);
});

const plain = { unity: false, network: false, extraDirs: 0, isGod: false };

test('exclusion: agy is ruled out only by a stored sandbox level, since it runs unsandboxed', () => {
  const agy = { provider: 'antigravity' };
  assert.equal(entryExclusion(agy, plain), null);
  assert.equal(entryExclusion(agy, { ...plain, unity: true, network: true, extraDirs: 2 }), null,
    'no sandbox means no lost access');
  assert.match(entryExclusion(agy, { ...plain, codexSandbox: 'sandboxed' }), /runs without a sandbox; this agent has a sandbox level set/);
  assert.match(entryExclusion(agy, { ...plain, codexSandbox: 'full' }), /sandbox level set/);
});

test('exclusion: Claude keeps Unity, extra folders and network but not the Codex full level', () => {
  const claude = { provider: 'claude', model: 'claude-opus-4-8' };
  assert.equal(entryExclusion(claude, { ...plain, unity: true, extraDirs: 1, codexSandbox: 'sandboxed' }), null);
  assert.equal(entryExclusion(claude, { ...plain, network: true }), null, 'Claude Code is not network-sandboxed by default');
  assert.match(entryExclusion(claude, { ...plain, codexSandbox: 'full' }), /Codex-only/);
  assert.match(entryExclusion(claude, { ...plain, network: true, codexSandbox: 'full' }), /Codex-only/);
  assert.equal(entryExclusion({ provider: 'codex' }, { ...plain, unity: true, network: true, extraDirs: 3, codexSandbox: 'full' }), null);
});

test('exclusion: the Boss only runs where it can drain hive mail', () => {
  const noInbox = ['grok', 'kimi', 'gemini', 'qwen', 'opencode', 'crush', 'pi', 'copilot', 'cursor']
    .find((p) => entryExclusion({ provider: p }, { ...plain, isGod: true }) !== null);
  assert.ok(noInbox, 'some provider cannot receive inbox');
  assert.match(entryExclusion({ provider: noInbox }, { ...plain, isGod: true }), /hive mail/);
  assert.equal(entryExclusion({ provider: 'claude' }, { ...plain, isGod: true }), null);
});

test('cleanModelList drops unknown providers and repeats', () => {
  assert.deepEqual(cleanModelList([{ provider: 'codex', model: 'gpt-6-luna' }, { provider: 'nope' }, { provider: 'codex', model: 'gpt-6-luna' }, { provider: 'claude', model: '' }, 'x']),
    [{ provider: 'codex', model: 'gpt-6-luna' }, { provider: 'claude' }]);
  assert.deepEqual(cleanModelList(undefined), []);
});

test('lockout: the 2026-10-02 12:37 pick, re-scored from the Codex rollout and a later agy probe', () => {
  // Codex rate_limits at 17:37:21Z: 5h 20% resetting 1790979910, weekly 68% resetting 1791397518.
  // agy-claude read 37.72% (the higher of its windows; which one was not logged). Its 5h window
  // resets at 1790978689958 and its weekly at 1791514189958 (probe at 12:55).
  const at = 1790962648048;
  const codex = readEngine([
    { percent: 20, resetsAtMs: 1790979910000, lengthMs: FIVE_HOURS_MS },
    { percent: 68, resetsAtMs: 1791397518000, lengthMs: SEVEN_DAYS_MS }
  ], at);
  assert.equal(Math.round(codex.pace), 242);
  assert.equal((codex.lockoutMs / DAY).toFixed(1), '4.1', 'Codex runs dry in ~0.9 d and sits empty until Oct 7');
  const agy = (five, week) => readEngine([
    { percent: five, resetsAtMs: 1790978689958, lengthMs: FIVE_HOURS_MS },
    { percent: week, resetsAtMs: 1791514189958, lengthMs: SEVEN_DAYS_MS }
  ], at);
  const pick = (a) => balanceEngines([cand('codex', 'codex/gpt-6.1-sol'), cand('agy-claude', 'antigravity/Claude Opus 4.6 (Thinking)')], { codex, 'agy-claude': a }, at);

  // 37.72% on the 5h window (33 min in) and an empty week: only the 7d lockouts compare
  // (none against Codex's ~4.1 d), so agy-claude takes it.
  const fiveHour = pick(agy(37.72, 0));
  assert.equal(fiveHour.index, 1);
  assert.equal(fiveHour.reason, 'antigravity/Claude Opus 4.6 (Thinking) 0% of 7d, 5h 38%, pace 0%, no lockout; preferred codex/gpt-6.1-sol 68% of 7d, pace 242%, lockout ~4.1d: ~4.1d longer lockout');
  assert.equal(pick(agy(37.72, 23)).index, 1, 'a weekly under ~24% still locks out shorter than Codex');
  assert.equal(pick(agy(37.72, 24)).index, 0, 'at 24% weekly the lockouts tie, and pace keeps Codex');

  // 37.72% on the weekly window: ~5.1 d of lockout, longer than Codex's, so Codex stays.
  const weekly = pick(agy(0, 37.72));
  assert.equal(weekly.index, 0);
  assert.match(weekly.reason, /^codex\/gpt-6\.1-sol 68% of 7d, pace 242%, lockout ~4\.1d; also .* 38% of 7d, pace 377%, lockout ~5\.1d$/);
});

const { projectedLockoutMs, LOCKOUT_TIE_MS } = loadTs('src/main/engineChoice.ts');

test('lockout: reset minus the run-out time at the pace so far', () => {
  assert.ok(Math.abs(projectedLockoutMs(win(68, SEVEN_DAYS_MS, 3.5 * DAY), NOW) - 7 * DAY * (1 - 100 / 136)) < 1);
  assert.equal(projectedLockoutMs(win(50, FIVE_HOURS_MS, 2.5 * HOUR), NOW), 0, 'pace 100% runs dry exactly at reset');
  assert.equal(projectedLockoutMs(win(30, FIVE_HOURS_MS, 4 * HOUR), NOW), 0);
  assert.equal(projectedLockoutMs({ percent: 80, resetsAtMs: NOW + HOUR }, NOW), 0, 'no length, no projection');
  assert.equal(projectedLockoutMs(win(100, FIVE_HOURS_MS, 2 * HOUR), NOW), 3 * HOUR, 'spent now: empty until reset');
  // The elapsed floor: 20% two minutes into 5h projects as 20% per 30 min, out at 2.5 h.
  assert.ok(Math.abs(projectedLockoutMs(win(20, FIVE_HOURS_MS, 2 * 60_000), NOW) - 2.5 * HOUR) < 1);
  const r = readEngine([win(95, FIVE_HOURS_MS, FIVE_HOURS_MS - RESET_SOON_MS + 1), win(10, SEVEN_DAYS_MS, 6 * DAY)], NOW);
  assert.equal(r.lockoutMs, 0, 'a window resetting soon reads 0% and cannot lock out');
});

test('lockout: an engine takes its longest window lockout', () => {
  const r = readEngine([win(60, FIVE_HOURS_MS, HOUR), win(40, SEVEN_DAYS_MS, 2 * DAY)], NOW);
  assert.ok(Math.abs(r.lockoutMs - 7 * DAY * (1 - 100 / 140)) < 1, 'the 7d lockout (2 d) beats the 5h one (~3.3 h)');
});

test('lockout: shorter projected lockout wins before pace is compared', () => {
  // codex paces lower (150% on 7d, ~2.3 d out) than claude (300% on 5h, ~3.3 h out);
  // pace alone would keep codex, the lockout sends the agent to claude.
  const readings = {
    codex: readEngine([win(45, SEVEN_DAYS_MS, 2.1 * DAY)], NOW),
    claude: readEngine([win(60, FIVE_HOURS_MS, HOUR)], NOW)
  };
  assert.ok(readings.codex.pace < readings.claude.pace);
  const r = balanceEngines([cand('codex'), cand('claude')], readings, NOW);
  assert.equal(r.index, 1);
  assert.match(r.reason, /^claude 60% of 5h, pace 300%, lockout ~3\.3h; preferred codex 45% of 7d, pace 150%, lockout ~2\.3d: ~2\.2d longer lockout$/);
  assert.equal(limitSwitchPick([cand('codex'), cand('claude')], readings, NOW).index, 1, 'limit switches rank the same way');
  assert.equal(chooseEngine(['codex', 'claude'], readings, all).engine.id, 'claude', 'and so does a worker spawn ladder');
  // Reversed order: the preferred entry already has the shorter lockout, so it stays even
  // though a later one paces far lower.
  assert.equal(balanceEngines([cand('claude'), cand('codex')], readings, NOW).index, 0);
});

test('lockout: within LOCKOUT_TIE_MS the pace rule decides', () => {
  assert.equal(LOCKOUT_TIE_MS, HOUR);
  // Both 5h windows run dry: 50% at 1 h (pace 250%, out ~3 h) vs 40% at 1 h (pace 200%, out ~2.5 h).
  const close = {
    claude: readEngine([win(50, FIVE_HOURS_MS, HOUR)], NOW),
    codex: readEngine([win(40, FIVE_HOURS_MS, HOUR)], NOW)
  };
  assert.ok(Math.abs(close.claude.lockoutMs - close.codex.lockoutMs) < LOCKOUT_TIE_MS);
  const r = balanceEngines([cand('claude'), cand('codex')], close, NOW);
  assert.equal(r.index, 1, 'tied on lockout, codex paces 50 points lower');
  assert.match(r.reason, /paces 50 points higher$/);
  // Neither runs dry: both "no lockout", so pace and HEADROOM_MARGIN decide as before.
  const calm = { claude: readEngine([win(40, FIVE_HOURS_MS, 4 * HOUR)], NOW), codex: readEngine([win(30, FIVE_HOURS_MS, 4 * HOUR)], NOW) };
  assert.equal(balanceEngines([cand('claude'), cand('codex')], calm, NOW).index, 0);
  assert.match(balanceEngines([cand('claude'), cand('codex')], calm, NOW).reason, /^claude 40% of 5h, pace 50%, no lockout; also codex 30% of 5h, pace 38%, no lockout$/);
});

test('lockout: a full entry is still skipped however short its lockout', () => {
  const readings = {
    claude: readEngine([win(86, FIVE_HOURS_MS, 4.5 * HOUR)], NOW),
    codex: readEngine([win(50, SEVEN_DAYS_MS, 2 * DAY)], NOW)
  };
  assert.ok(readings.claude.lockoutMs < readings.codex.lockoutMs);
  assert.equal(balanceEngines([cand('codex'), cand('claude')], readings, NOW).index, 0);
});

const { RESET_PRIORITY_MS } = loadTs('src/main/engineChoice.ts');

test('reset soon: a 7d window resetting soon with room beats a fresher engine', () => {
  // codex: 40% with 6 h left, pace 41%, ~59% left unused at reset (9.8%/h). claude: 10% with
  // 4 d left, pace 23% (0.8%/h). Pace alone (under HEADROOM_MARGIN apart) would keep claude.
  const readings = {
    claude: readEngine([win(10, SEVEN_DAYS_MS, 3 * DAY)], NOW),
    codex: readEngine([win(40, SEVEN_DAYS_MS, SEVEN_DAYS_MS - 6 * HOUR)], NOW)
  };
  assert.ok(6 * HOUR < RESET_PRIORITY_MS);
  const r = balanceEngines([cand('claude'), cand('codex')], readings, NOW);
  assert.equal(r.index, 1);
  assert.equal(r.reason, 'codex 40% of 7d, pace 41%, no lockout, resets in ~6.0h; preferred claude 10% of 7d, pace 23%, no lockout: 9.8%/h left unused at reset against 0.8%/h');
  assert.equal(balanceEngines([cand('codex'), cand('claude')], readings, NOW).index, 0, 'and it keeps the agent when it is preferred');
  assert.equal(limitSwitchPick([cand('claude'), cand('codex')], readings, NOW).index, 1);
  assert.equal(chooseEngine(['claude', 'codex'], readings, all).engine.id, 'codex', 'temporary workers too');
});

test('reset soon: a near-reset engine that is full does not win', () => {
  const fresh = readEngine([win(10, SEVEN_DAYS_MS, 3 * DAY)], NOW);
  // 98% with 12 h left paces 106%: it locks out before the reset, so the full skip holds.
  const weekFull = readEngine([win(98, SEVEN_DAYS_MS, SEVEN_DAYS_MS - 12 * HOUR)], NOW);
  assert.ok(weekFull.lockoutMs > 0);
  assert.equal(weekFull.spendBeforeReset, undefined);
  const r = balanceEngines([cand('claude'), cand('codex')], { claude: fresh, codex: weekFull }, NOW);
  assert.equal(r.index, 0);
  assert.match(r.reason, /skipped codex 98% of 7d, pace 106%, lockout ~/);
  const spent = readEngine([win(100, SEVEN_DAYS_MS, SEVEN_DAYS_MS - 6 * HOUR)], NOW);
  assert.equal(balanceEngines([cand('codex'), cand('claude')], { claude: fresh, codex: spent }, NOW).index, 1, 'a spent week is skipped');
  // The 5h guard holds too: 60% of the week unused, but a 5h at ENGINE_FULL_PERCENT skips it.
  const fiveFull = readEngine([win(ENGINE_FULL_PERCENT, FIVE_HOURS_MS, 2 * HOUR), win(40, SEVEN_DAYS_MS, SEVEN_DAYS_MS - 6 * HOUR)], NOW);
  const g = balanceEngines([cand('claude'), cand('codex')], { claude: fresh, codex: fiveFull }, NOW);
  assert.equal(g.index, 0);
  assert.match(g.reason, /skipped codex 40% of 7d, 5h 85%/);
});

test('reset soon: the 2026-10-23 19:08Z pick spends Claude\'s last 6% instead of Codex at 3x pace', () => {
  // engine-ledger agent-pick rows 1792780112937 (Birch) and 1792780288831 (Cedar) took
  // codex at 44% of 7d, pace 308%, and skipped claude at 94% of 7d, pace 95%, no lockout.
  // Elapsed shares are recovered from those percent/pace pairs.
  const readings = {
    codex: readEngine([win(44, SEVEN_DAYS_MS, (SEVEN_DAYS_MS * 44) / 308)], NOW),
    'agy-claude': readEngine([win(99.08, SEVEN_DAYS_MS, (SEVEN_DAYS_MS * 99.08) / 118)], NOW),
    claude: readEngine([win(94, SEVEN_DAYS_MS, (SEVEN_DAYS_MS * 94) / 95)], NOW),
    agy: readEngine([win(78.58, SEVEN_DAYS_MS, (SEVEN_DAYS_MS * 78.58) / 82)], NOW)
  };
  assert.equal(readings.claude.spendBeforeReset, true);
  assert.equal(readings.codex.unusedPerHour, 0, 'over pace, nothing is left to lose at its reset');
  const ladder = [cand('codex', 'codex/gpt-6.1-sol'), cand('agy-claude', 'antigravity/claude-opus-5-5-medium'), cand('claude', 'claude/claude-opus-5-5')];
  const r = balanceEngines(ladder, readings, NOW);
  assert.equal(r.index, 2);
  assert.match(r.reason, /^claude\/claude-opus-5-5 94% of 7d, pace 95%, no lockout, resets in ~1\.8h; preferred codex\/gpt-6\.1-sol 44% of 7d, pace 308%, lockout ~4\.7d: 2\.8%\/h left unused at reset against 0\.0%\/h; skipped antigravity\/claude-opus-5-5-medium 99% of 7d/);
  // Cedar's ladder also lists agy, 79% resetting in ~7 h with ~18% left unused (2.5%/h).
  const c = balanceEngines([...ladder, cand('agy', 'antigravity/Gemini 3.8 Flash (High)')], readings, NOW);
  assert.equal(c.index, 2);
});

test('reset soon: the higher unused rate wins, and a 5h-only engine counts 0', () => {
  // Both weeks reset within a day: 70% with 3 h left (9.6%/h) beats 30% with 20 h left (3.3%/h).
  const readings = {
    claude: readEngine([win(30, SEVEN_DAYS_MS, SEVEN_DAYS_MS - 20 * HOUR)], NOW),
    codex: readEngine([win(70, SEVEN_DAYS_MS, SEVEN_DAYS_MS - 3 * HOUR)], NOW),
    agy: readEngine([win(5, FIVE_HOURS_MS, HOUR)], NOW)
  };
  assert.equal(balanceEngines([cand('claude'), cand('codex')], readings, NOW).index, 1);
  assert.equal(readings.agy.unusedPerHour, undefined, 'no window longer than RESET_PRIORITY_MS');
  assert.equal(balanceEngines([cand('agy'), cand('claude')], readings, NOW).index, 1);
  // A week that resets within RESET_SOON_MS reads 0% but its rate counts the real room left.
  const last = readEngine([win(80, SEVEN_DAYS_MS, SEVEN_DAYS_MS - 10 * 60_000)], NOW);
  assert.equal(last.percent, 0);
  assert.ok(Math.abs(last.unusedPerHour - (100 - 80 / (1 - 10 / 10080)) * 6) < 1e-9);
});

test('reset soon: an engine at 86% with reset in 1h is picked via spendBeforeReset', () => {
  // An engine at 86% of its 7-day window with 1h remaining projects no lockout (pace ~86.5%),
  // so spendBeforeReset marks it with room and its high unused rate (~13.5%/h) wins over a fresher engine.
  const readings = {
    claude: readEngine([win(50, SEVEN_DAYS_MS, 3 * DAY)], NOW),
    agy: readEngine([win(86, SEVEN_DAYS_MS, 7 * DAY - HOUR)], NOW)
  };
  assert.equal(readings.agy.spendBeforeReset, true);
  assert.equal(readings.agy.resetInMs, HOUR);
  assert.equal(readings.agy.lockoutMs, 0);

  const ladder = [
    cand('claude', 'claude/claude-opus-5-5'),
    cand('agy', 'antigravity/Gemini 3.8 Flash (High)')
  ];
  const r = balanceEngines(ladder, readings, NOW);
  assert.equal(r.index, 1);
  assert.match(r.reason, /^antigravity\/Gemini 3\.8 Flash \(High\) 86% of 7d, pace 87%, no lockout, resets in ~1\.0h; preferred claude\/claude-opus-5-5 50% of 7d, pace 117%, lockout ~1\.0d: 13\.5%\/h left unused at reset against 0\.0%\/h/);

  const c = chooseEngine(['claude', 'agy'], readings, all);
  assert.equal(c.engine.id, 'agy');
  assert.match(c.reason, /^agy 86% of 7d, pace 87%, no lockout, resets in ~1\.0h/);
});

test('Argon is scored on its own spent pool, not the Gemini pool', () => {
  const { parseAgyQuota, agyPoolWindows } = loadTs('src/main/agyQuotaParse.ts');
  const text = require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures', 'agy-quota-argon.screen.txt'), 'utf8');
  const q = parseAgyQuota(text, NOW);
  const pool = (label) => agyPoolWindows(q.pools.find((p) => p.label === label), NOW);
  const readings = { agy: readEngine(pool('gem'), NOW), 'agy-argon': readEngine(pool('argon'), NOW), 'agy-claude': readEngine(pool('claude'), NOW) };
  assert.equal(readings['agy-argon'].percent, 100);
  assert.equal(readings['agy-argon'].roomAtMs, NOW + (50 * 60 + 6) * 60_000);
  const r = balanceEngines([cand('agy-argon', 'antigravity/Gemini 4 Argon (Medium)'), cand('agy', 'antigravity/Gemini 3.8 Flash')], readings, NOW);
  assert.equal(r.index, 1);
  assert.match(r.reason, /skipped antigravity\/Gemini 4 Argon \(Medium\) 100% of 7d/);
  assert.deepEqual(parseEngineList(['agy-argon']), [], 'a spawn request cannot name Argon');
});


test('engineFor maps the new Antigravity aliases to the observed quota pools', () => {
  assert.equal(engineFor('antigravity', 'gemini-4-neon-xhigh'), 'agy');
  assert.equal(engineFor('antigravity', 'gemini-4-hydrogen-xhigh'), 'agy');
  assert.equal(engineFor('antigravity', 'gemini-pro-orchestrator-neon'), 'agy');
  assert.equal(engineFor('antigravity', 'gemini-pro-orchestrator-g1-pro'), 'agy-argon');
});
