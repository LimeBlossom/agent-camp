'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { DENYLIST_ROT13, rot13, auditTree } = require('../scripts/public-export-audit.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const AUDIT_CLI = path.join(REPO_ROOT, 'scripts', 'public-export-audit.cjs');
const EXPORT_SCRIPT = path.join(REPO_ROOT, 'scripts', 'public-export.sh');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-export-audit-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('audit denylist catches all four terms case-insensitively in contents, escapes, and filenames', () => {
  assert.equal(DENYLIST_ROT13.length, 4);
  const terms = DENYLIST_ROT13.map(rot13);

  for (const term of terms) {
    withTempDir((dir) => {
      // Lowercase, Title/Upper, hyphenated, and escaped-newline variants
      const upper = term.toUpperCase();
      fs.writeFileSync(path.join(dir, 'lower.txt'), `host: ${term}-earlyoom-tune\n`);
      fs.writeFileSync(path.join(dir, 'upper.txt'), `note: ${upper} box\n`);
      fs.writeFileSync(path.join(dir, 'escaped.txt'), `line1\\n${term} telemetry\n`);
      fs.writeFileSync(path.join(dir, `${term}-config.txt`), 'clean body\n');

      const offenders = auditTree(dir);
      assert.equal(offenders.length, 4, `expected 4 hits for ${rot13(term)}, got: ${offenders.join(', ')}`);

      const cli = spawnSync(process.execPath, [AUDIT_CLI, dir], { encoding: 'utf8' });
      assert.notEqual(cli.status, 0, `audit CLI must fail for ${rot13(term)}`);
      assert.match(cli.stderr, /public-export-audit FAILED/);
    });
  }
});

test('audit passes on clean generic host, monitor, and telemetry fixtures', () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'ask-relay.txt'), "id: 'host-earlyoom-tune'\n");
    fs.writeFileSync(path.join(dir, 'syslog.txt'), 'Nov 23 19:31:02 devbox earlyoom[1432]: sending SIGTERM\n');
    fs.writeFileSync(path.join(dir, 'telemetry.txt'), '// games that honour this flag send no telemetry\n');
    fs.writeFileSync(path.join(dir, 'layout.txt'), '// dual-monitor Linux host layout: 3440x1440 ultrawide\n');

    assert.deepEqual(auditTree(dir), []);

    const cli = spawnSync(process.execPath, [AUDIT_CLI, dir], { encoding: 'utf8' });
    assert.equal(cli.status, 0, `expected exit 0, got ${cli.status}: ${cli.stderr}`);
    assert.match(cli.stdout, /public-export-audit OK/);
  });
});

test('public-export.sh fails when the archived tree contains a denylisted identifier', () => {
  withTempDir((dir) => {
    const srcRepo = path.join(dir, 'src');
    const outDir = path.join(dir, 'out');
    fs.mkdirSync(srcRepo);
    execFileSync('git', ['-C', srcRepo, 'init', '-q', '-b', 'main']);
    execFileSync('git', ['-C', srcRepo, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', srcRepo, 'config', 'user.email', 'test@example.com']);
    fs.writeFileSync(path.join(srcRepo, 'note.txt'), `Host is ${rot13(DENYLIST_ROT13[0])}\n`);
    execFileSync('git', ['-C', srcRepo, 'add', 'note.txt']);
    execFileSync('git', ['-C', srcRepo, 'commit', '-q', '-m', 'seed']);

    const run = spawnSync('bash', [EXPORT_SCRIPT, srcRepo, 'HEAD', outDir], { encoding: 'utf8' });
    assert.notEqual(run.status, 0, 'public-export.sh must exit non-zero on denylisted content');
    assert.match(run.stderr, /public-export-audit FAILED/);
  });
});

test('current repo tree contains no denylisted machine, studio, or telemetry identifiers', () => {
  const offenders = auditTree(REPO_ROOT);
  assert.deepEqual(
    offenders,
    [],
    'scrub denylisted machine/studio/telemetry identifiers from the repo so public exports stay clean'
  );
});
