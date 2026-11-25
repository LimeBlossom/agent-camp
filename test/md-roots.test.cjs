'use strict';

/**
 * Which files an ASK ME question may show. An agent names a screenshot by its
 * absolute path; the card shows it only when that path sits inside one of the
 * workspaces the card was given, and never for anything outside them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');

const { resolveUnderRoots, isRemoteImage } = loadTs('src/renderer/src/markdown/mdLinks.ts');

const ROOTS = ['/home/me/repo', '/home/me/hive/'];

test('an absolute path under a root splits into that root and its relative path', () => {
  assert.deepEqual(resolveUnderRoots(ROOTS, '/home/me/repo/Captures/a.png'), { root: '/home/me/repo', rel: 'Captures/a.png' });
  assert.deepEqual(resolveUnderRoots(ROOTS, '/home/me/hive/x.png'), { root: '/home/me/hive', rel: 'x.png' });
});

test('a file:// URL resolves like its path, percent-encoding decoded', () => {
  assert.deepEqual(resolveUnderRoots(ROOTS, 'file:///home/me/repo/My%20Shot.png'), { root: '/home/me/repo', rel: 'My Shot.png' });
});

test('anything outside every root, or not absolute, is refused', () => {
  assert.equal(resolveUnderRoots(ROOTS, '/etc/passwd'), null);
  assert.equal(resolveUnderRoots(ROOTS, '/home/me/repository/a.png'), null, 'a sibling that shares a prefix is not inside');
  assert.equal(resolveUnderRoots(ROOTS, 'Captures/a.png'), null);
  assert.equal(resolveUnderRoots(ROOTS, 'https://example.com/a.png'), null);
  assert.equal(resolveUnderRoots([], '/home/me/repo/a.png'), null);
});

test('dot segments cannot climb out of the root they matched', () => {
  assert.deepEqual(resolveUnderRoots(ROOTS, '/home/me/repo/../../../etc/passwd'), { root: '/home/me/repo', rel: 'etc/passwd' });
});

test('only http(s) URLs to images count as remote images', () => {
  assert.equal(isRemoteImage('https://example.com/a.png?v=2'), true);
  assert.equal(isRemoteImage('https://example.com/page'), false);
  assert.equal(isRemoteImage('/home/me/repo/a.png'), false);
});

test('image candidates: a relative path tries every root in order, an absolute one only its own', () => {
  const { imageCandidatesUnderRoots } = loadTs('src/renderer/src/markdown/mdLinks.ts');
  assert.deepEqual(imageCandidatesUnderRoots(ROOTS, 'agents/p/shot.png'), [
    { root: '/home/me/repo', rel: 'agents/p/shot.png' },
    { root: '/home/me/hive', rel: 'agents/p/shot.png' },
  ]);
  assert.deepEqual(imageCandidatesUnderRoots(ROOTS, '/home/me/hive/x.png'), [{ root: '/home/me/hive', rel: 'x.png' }]);
  assert.deepEqual(imageCandidatesUnderRoots(ROOTS, '/etc/x.png'), []);
  assert.deepEqual(imageCandidatesUnderRoots(ROOTS, '../../etc/x.png'), ROOTS.map((r) => ({ root: r.replace(/\/+$/, ''), rel: 'etc/x.png' })));
  assert.deepEqual(imageCandidatesUnderRoots(ROOTS, 'notes.md'), []);
  assert.deepEqual(imageCandidatesUnderRoots(ROOTS, 'https://example.com/a.png'), []);
});

test('file candidates: path-shaped tokens only, tried under every root', () => {
  const { fileCandidatesUnderRoots } = loadTs('src/renderer/src/markdown/mdLinks.ts');
  assert.deepEqual(fileCandidatesUnderRoots(ROOTS, 'agents/f/plateau-analysis.md'),
    ['/home/me/repo/agents/f/plateau-analysis.md', '/home/me/hive/agents/f/plateau-analysis.md']);
  assert.deepEqual(fileCandidatesUnderRoots(ROOTS, '/home/me/hive/notes.txt'), ['/home/me/hive/notes.txt']);
  assert.deepEqual(fileCandidatesUnderRoots(ROOTS, '/etc/passwd.x'), []);
  assert.deepEqual(fileCandidatesUnderRoots(ROOTS, '/home/me/hive/agents/p/sprites/v4/'), ['/home/me/hive/agents/p/sprites/v4']);
  assert.deepEqual(fileCandidatesUnderRoots(ROOTS, '/etc/ssh/'), []);
  assert.deepEqual(fileCandidatesUnderRoots(ROOTS, '/home/me/repo/Business/Alpha Content Pipeline.md'),
    ['/home/me/repo/Business/Alpha Content Pipeline.md']);
  for (const prose of ['npm test', 'foo.md', 'a/b', 'https://x.io/a.md', 'set(Shape)', 'git add a/b.md', '/etc/my file.md']) {
    assert.deepEqual(fileCandidatesUnderRoots(ROOTS, prose), [], prose);
  }
});

test('with the home folder as the last root, a path an agent cites outside every workspace links', () => {
  const { fileCandidatesUnderRoots } = loadTs('src/renderer/src/markdown/mdLinks.ts');
  const roots = ['/home/me/vault', '/home/me/HarnessAgents/hive', '/home/me/HarnessAgents', '/home/me'];
  assert.deepEqual(fileCandidatesUnderRoots(roots, '/home/me/social-dashboard/README.md'), ['/home/me/social-dashboard/README.md']);
  assert.deepEqual(fileCandidatesUnderRoots(roots, '/etc/passwd.x'), []);
});

test('a relative folder path with a trailing slash links; a bare folder resolves beside its sibling', () => {
  const { fileCandidatesUnderRoots, siblingRoots } = loadTs('src/renderer/src/markdown/mdLinks.ts');
  assert.deepEqual(fileCandidatesUnderRoots(ROOTS, 'agents/b/unity-results/run-1/'),
    ['/home/me/repo/agents/b/unity-results/run-1', '/home/me/hive/agents/b/unity-results/run-1']);
  const q = 'Frame strips: `agents/b/unity-results/run-1/` and `run-2/`.';
  const extra = siblingRoots(ROOTS, q);
  assert.deepEqual(extra, ['/home/me/repo/agents/b/unity-results', '/home/me/hive/agents/b/unity-results']);
  assert.ok(fileCandidatesUnderRoots([...ROOTS, ...extra], 'run-2/').includes('/home/me/hive/agents/b/unity-results/run-2'));
  assert.deepEqual(siblingRoots(ROOTS, 'no paths here, `npm test`'), []);
});

test('video candidates: mp4/webm paths resolve like images; images and docs are not videos', () => {
  const { videoCandidatesUnderRoots } = loadTs('src/renderer/src/markdown/mdLinks.ts');
  const { videoMimeForPath } = loadTs('src/shared/imageTypes.ts');
  assert.equal(videoMimeForPath('a/b.MP4?v=2'), 'video/mp4');
  assert.equal(videoMimeForPath('a/b.webm'), 'video/webm');
  assert.equal(videoMimeForPath('a/b.png'), null);
  assert.deepEqual(videoCandidatesUnderRoots(ROOTS, '/home/me/hive/card-attachments/c/clip.mp4'), [{ root: '/home/me/hive', rel: 'card-attachments/c/clip.mp4' }]);
  assert.deepEqual(videoCandidatesUnderRoots(ROOTS, 'x/clip.webm'), ROOTS.map((r) => ({ root: r.replace(/\/+$/, ''), rel: 'x/clip.webm' })));
  assert.deepEqual(videoCandidatesUnderRoots(ROOTS, '/etc/clip.mp4'), []);
  assert.deepEqual(videoCandidatesUnderRoots(ROOTS, 'a.png'), []);
  assert.deepEqual(videoCandidatesUnderRoots(ROOTS, 'https://e.com/a.mp4'), []);
});

test('readFileBinary labels a video with its mime and allows more than the image cap', async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { readFileBinary } = loadTs('src/main/fs.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-vid-'));
  try {
    fs.writeFileSync(path.join(dir, 'c.mp4'), Buffer.alloc(11 * 1024 * 1024));
    const r = await readFileBinary(dir, 'c.mp4');
    assert.equal(r.ok, true, r.error);
    assert.equal(r.mime, 'video/mp4');
    fs.writeFileSync(path.join(dir, 'big.png'), Buffer.alloc(11 * 1024 * 1024));
    assert.equal((await readFileBinary(dir, 'big.png')).ok, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
