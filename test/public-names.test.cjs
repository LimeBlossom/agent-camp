// The repo is public. Franchise names (a fan theme pack is kept in a separate private repo)
// and the maintainer's personal names and project names stay out of it, in file contents
// and file names alike. The words are rot13 so this file does not match itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rot13 = (s) => s.replace(/[a-z]/gi, (c) => {
  const base = c <= 'Z' ? 65 : 97;
  return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
});

const FRANCHISE = ['cbxrzba', 'cbxézba', 'cvxnpuh', 'czqpbyyno', 'czq-fcevgrf', 'rzrenyq', 'cbxr pnzc', 'cbxrpnzc', 'cbxr-pnzc',
  'ohyonfnhe', 'puneznaqre', 'puvxbevgn', 'sraarxva', 'sebnxvr', 'shrpbpb', 'tebbxrl', 'cvcyhc', 'dhnkyl', 'fpbeohaal', 'favil',
  'fdhvegyr', 'gbgbqvyr', 'rrirr', 'tratne', 'fabeynk', 'purfcva'];
const PERSONAL = ['yvzr', 'yvzroybffbz', 'xevgg', 'jje', 'jurarire jr evfr', 'jurarirejrevfr', 'ubub', 'ubireobnequbfgvyr',
  'ubireobneq ubfgvyr', 'tenivglgnpgvpf', 'tenivgl gnpgvpf', 'puvyyfrrxref',
  'juvgrxavtug', 'qrzqrz', 'oybffbz', 'cynlsno'];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[\\s_-]?');
const wordRe = (words) => new RegExp(`(?<![a-z0-9])(?:${words.map(rot13).map(escape).join('|')})(?![a-z0-9])`, 'i');
const CLASSES = { franchise: wordRe(FRANCHISE), personal: wordRe(PERSONAL) };
// Any real home dir (or a prefix of one, like a truncated fixture) leaks a username; only placeholders pass.
const PLACEHOLDER_HOMES = new Set(['', 'me', 'u', 'user', 'x']);
const homeLeak = (text) => [...text.matchAll(/\/home\/([A-Za-z0-9._-]*)/g)].find((m) => !PLACEHOLDER_HOMES.has(m[1]))?.[0];
// A string escape like \n puts a letter right before the next word, which would hide it from the word boundary.
const unescape = (text) => text.replace(/\\[nrtbfv0]/g, ' ');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'out', 'research']);
const isSkippedDir = (name) => SKIP_DIRS.has(name) || name.startsWith('dist');

function files() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!isSkippedDir(e.name)) walk(p); }
      else if (e.isFile() && e.name !== '.git') out.push(p);
    }
  };
  walk(ROOT);
  return out;
}

test('no franchise or personal names in the repo\'s files or file names', () => {
  const offenders = [];
  for (const p of files()) {
    const rel = path.relative(ROOT, p);
    const buf = fs.readFileSync(p);
    const text = buf.includes(0) ? '' : unescape(buf.toString('utf8'));
    for (const [cls, re] of Object.entries(CLASSES)) {
      const hit = re.exec(rel) ?? re.exec(text);
      if (hit) offenders.push(`${rel}: ${cls} (${rot13(hit[0])} in rot13)`);
    }
    const home = homeLeak(text);
    if (home) offenders.push(`${rel}: home dir (${rot13(home)} in rot13)`);
  }
  assert.deepEqual(offenders, [], 'use neutral names: the fan pack lives in its own private repo, and personal names belong in config');
});
