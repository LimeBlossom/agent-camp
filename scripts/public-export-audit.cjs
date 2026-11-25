#!/usr/bin/env node
'use strict';

// Export audit for machine, studio, and telemetry identifiers that must not
// appear in public exports. Patterns are stored in rot13 so this file never
// matches itself.
const fs = require('node:fs');
const path = require('node:path');

const rot13 = (s) => s.replace(/[a-z]/gi, (c) => {
  const base = c <= 'Z' ? 65 : 97;
  return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
});

const DENYLIST_ROT13 = [
  'juvgrxavtug',
  'qrzqrz',
  'oybffbz',
  'cynlsno',
];

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const DENY_RE = new RegExp(`(?:${DENYLIST_ROT13.map(rot13).map(escapeRegex).join('|')})`, 'i');

const SKIP_DIRS = new Set(['.git', 'node_modules', 'out', 'research']);
const isSkippedDir = (name) => SKIP_DIRS.has(name) || name.startsWith('dist');
const unescapeText = (text) => text.replace(/\\[nrtbfv0]/g, ' ');

function walkFiles(rootDir) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!isSkippedDir(entry.name)) walk(fullPath);
      } else if (entry.isFile() && entry.name !== '.git') {
        out.push(fullPath);
      }
    }
  };
  walk(rootDir);
  return out;
}

function findLeak(text, relPath) {
  const pathHit = DENY_RE.exec(relPath);
  if (pathHit) return pathHit[0];
  const contentHit = DENY_RE.exec(unescapeText(text));
  if (contentHit) return contentHit[0];
  return null;
}

function auditTree(rootDir) {
  const offenders = [];
  for (const fullPath of walkFiles(rootDir)) {
    const rel = path.relative(rootDir, fullPath);
    const buf = fs.readFileSync(fullPath);
    const text = buf.includes(0) ? '' : buf.toString('utf8');
    const hit = findLeak(text, rel);
    if (hit) {
      offenders.push(`${rel}: denylisted identifier (${rot13(hit)} in rot13)`);
    }
  }
  return offenders;
}

module.exports = {
  DENYLIST_ROT13,
  DENY_RE,
  rot13,
  findLeak,
  auditTree,
};

if (require.main === module) {
  const targetDir = path.resolve(process.argv[2] || path.join(__dirname, '..'));
  const offenders = auditTree(targetDir);
  if (offenders.length > 0) {
    console.error(`public-export-audit FAILED (${offenders.length} file(s)):`);
    for (const line of offenders) console.error(`  ${line}`);
    process.exit(1);
  }
  console.log(`public-export-audit OK (${targetDir})`);
}
