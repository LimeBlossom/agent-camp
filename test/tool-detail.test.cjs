'use strict';

/** The phrase a working agent's bubble shows for a tool call. */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');

const { toolDetail } = loadTs('src/shared/toolDetail.ts');

test('Bash prefers the call\'s own description, then the command', () => {
  assert.equal(toolDetail('Bash', { command: 'npm test', description: 'Run the unit tests' }), 'Run the unit tests');
  assert.equal(toolDetail('Bash', { command: 'git   status\n' }), 'running git status');
});

test('file tools name the file, not the path', () => {
  assert.equal(toolDetail('Read', { file_path: '/a/b/OfficeFloor.tsx' }), 'reading OfficeFloor.tsx');
  assert.equal(toolDetail('Edit', { file_path: 'C:\\x\\y.cs' }), 'editing y.cs');
  assert.equal(toolDetail('Write', { file_path: '/t/notes.md' }), 'writing notes.md');
});

test('searches, fetches, delegation and MCP read as sentences', () => {
  assert.equal(toolDetail('Grep', { pattern: 'set(Shape|Bounds)' }), 'searching the code');
  assert.equal(toolDetail('Grep', { pattern: 'x', path: '/repo/src/main' }), 'searching main');
  assert.equal(toolDetail('Glob', { pattern: '**/*.ts' }), 'looking for files');
  assert.equal(toolDetail('WebFetch', { url: 'https://docs.unity3d.com/Manual/x.html' }), 'reading docs.unity3d.com');
  assert.equal(toolDetail('Task', { description: 'audit the build' }), 'delegating: audit the build');
  assert.equal(toolDetail('mcp__blender__get_scene_info', {}), 'get scene info (blender)');
});

test('long text is clipped, and nothing useful gives undefined', () => {
  assert.ok(toolDetail('Bash', { command: 'x'.repeat(200) }).length <= 80);
  assert.equal(toolDetail('Read', {}), undefined);
  assert.equal(toolDetail('SomethingNew', { a: 1 }), undefined);
  assert.equal(toolDetail(undefined, {}), undefined);
});
