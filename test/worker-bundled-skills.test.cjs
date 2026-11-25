/**
 * `workerDisableBundledSkills` writes `disableBundledSkills: true` into a Claude
 * worker's per-session settings, never into the Boss's, and nothing when off.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { Notification: class { show() {} static isSupported() { return false; } } }
};

const { HiveManager } = loadTs('src/main/hive.ts');

async function settingsFor(meta, opts) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-bundled-'));
  const hive = new HiveManager(() => home);
  const inj = await hive.ensureAgent({ provider: 'claude', cwd: home, ...meta }, opts);
  const i = inj.args.indexOf('--settings');
  assert.ok(i >= 0, 'claude spawn carries --settings');
  return JSON.parse(fs.readFileSync(inj.args[i + 1], 'utf8'));
}

test('a worker gets disableBundledSkills when the option is on', async () => {
  const s = await settingsFor({ id: 'jim-1', name: 'Jim' }, { disableBundledSkills: true });
  assert.equal(s.disableBundledSkills, true);
  assert.ok(s.hooks && s.hooks.Stop, 'hook block still written');
});

test('the Boss keeps bundled skills even when the option is on', async () => {
  const s = await settingsFor({ id: 'god-1', name: 'Michael', isGod: true }, { disableBundledSkills: true });
  assert.equal('disableBundledSkills' in s, false);
});

test('off: no key written', async () => {
  const s = await settingsFor({ id: 'jim-2', name: 'Jim' }, {});
  assert.equal('disableBundledSkills' in s, false);
});

test('config defaults the worker filter on', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/config.ts'), 'utf8');
  assert.match(src, /const DEFAULTS[\s\S]*?workerDisableBundledSkills: true,/);
});

test('a worker gets --strict-mcp-config and disallows Artifact and unused interactive tools', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-worker-args-'));
  const hive = new HiveManager(() => home);
  const inj = await hive.ensureAgent({ id: 'worker-1', name: 'Worker', provider: 'claude', cwd: home }, {});
  assert.ok(inj.args.includes('--strict-mcp-config'), 'worker must carry --strict-mcp-config');
  assert.equal(inj.args.includes('--chrome'), false, 'worker must not carry --chrome');
  const disIdx = inj.args.indexOf('--disallowed-tools');
  assert.ok(disIdx >= 0, 'worker must carry --disallowed-tools');
  assert.equal(inj.args[disIdx + 1], 'Artifact,SendFeedback,AskUserQuestion,ScheduleWakeup,ReportFindings');
});

test('the Boss carries --strict-mcp-config and --chrome but not --disallowed-tools', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-boss-args-'));
  const hive = new HiveManager(() => home);
  const inj = await hive.ensureAgent({ id: 'god-1', name: 'Michael', isGod: true, provider: 'claude', cwd: home }, {});
  assert.ok(inj.args.includes('--strict-mcp-config'), 'boss must carry --strict-mcp-config');
  assert.ok(inj.args.includes('--chrome'), 'boss must carry --chrome');
  assert.equal(inj.args.includes('--disallowed-tools'), false, 'boss must not disallow tools');
});

test('a worker with disableBundledSkills does not populate .claude/skills', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-skills-prune-'));
  const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-skills-src-'));
  fs.mkdirSync(path.join(skillsDir, 'test-skill'));
  fs.writeFileSync(path.join(skillsDir, 'test-skill', 'SKILL.md'), 'test');

  const hive = new HiveManager(() => home);
  await hive.ensureAgent(
    { id: 'worker-2', name: 'Worker', provider: 'claude', cwd: home },
    { skillsDir, disableBundledSkills: true }
  );

  const dest = path.join(home, 'hive', 'agents', 'worker-2', '.claude', 'skills');
  assert.equal(fs.existsSync(dest), false, 'worker .claude/skills should not exist when bundled skills are disabled');
});
