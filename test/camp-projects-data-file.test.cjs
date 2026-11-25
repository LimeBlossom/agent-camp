'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// The bundled-fallback cases need an empty hive root to mean "no hive", not the ambient one.
delete process.env.HIVE_ROOT;
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const {
  getValidProjects,
  getCampMcpTools,
  createCard,
  patchCard,
  dispatchTask,
  handleCampMcpCall,
  VALID_PROJECTS
} = loadTs('src/main/campTools.ts');

const {
  getProposeMcpTools,
  writeProposal,
  handleProposeMcpCall
} = loadTs('src/main/cardProposals.ts');

const initialCwdCreateCardFiles = new Set(
  fs.readdirSync(process.cwd()).filter((f) => f.endsWith('-create-card.json') || /-create-card.*\.json$/.test(f))
);

function tmpHive() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-camp-projects-'));
  const hiveRoot = path.join(dir, 'hive');
  const outboxDir = path.join(dir, 'outbox');
  fs.mkdirSync(hiveRoot, { recursive: true });
  fs.mkdirSync(outboxDir, { recursive: true });
  return { dir, hiveRoot, outboxDir };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. getValidProjects: present, missing, malformed
// ─────────────────────────────────────────────────────────────────────────────

test('getValidProjects loads projects from <hive>/projects.json when present', () => {
  assert.equal(typeof getValidProjects, 'function', 'getValidProjects must be exported as a function');
  const { dir, hiveRoot } = tmpHive();
  try {
    const customProjects = ['GammaGame', 'CustomApp', 'Camp', 'SpecialOps'];
    fs.writeFileSync(path.join(hiveRoot, 'projects.json'), JSON.stringify(customProjects, null, 2), 'utf8');

    const result = getValidProjects(hiveRoot);
    assert.deepEqual(result, customProjects, 'Should return the exact list of projects defined in projects.json');
  } finally {
    rmTree(dir);
  }
});

test('getValidProjects falls back to bundled VALID_PROJECTS when projects.json is missing', () => {
  assert.equal(typeof getValidProjects, 'function', 'getValidProjects must be exported as a function');
  const { dir, hiveRoot } = tmpHive();
  try {
    // No projects.json created
    const resultWithHive = getValidProjects(hiveRoot);
    assert.deepEqual(resultWithHive, VALID_PROJECTS, 'Should fall back to bundled VALID_PROJECTS when file missing');

    const resultWithoutHive = getValidProjects('');
    assert.deepEqual(resultWithoutHive, VALID_PROJECTS, 'Should fall back to bundled VALID_PROJECTS when hiveRoot is empty');

    const resultUndefined = getValidProjects();
    assert.deepEqual(resultUndefined, VALID_PROJECTS, 'Should fall back to bundled VALID_PROJECTS when hiveRoot is undefined');
  } finally {
    rmTree(dir);
  }
});

test('getValidProjects falls back to bundled VALID_PROJECTS when projects.json is malformed or invalid', () => {
  assert.equal(typeof getValidProjects, 'function', 'getValidProjects must be exported as a function');
  const { dir, hiveRoot } = tmpHive();
  try {
    // 1. Syntax error
    fs.writeFileSync(path.join(hiveRoot, 'projects.json'), '{ not valid json syntax', 'utf8');
    assert.deepEqual(getValidProjects(hiveRoot), VALID_PROJECTS, 'Should fall back on syntax error');

    // 2. Object instead of array
    fs.writeFileSync(path.join(hiveRoot, 'projects.json'), JSON.stringify({ projects: ['CustomApp'] }), 'utf8');
    assert.deepEqual(getValidProjects(hiveRoot), VALID_PROJECTS, 'Should fall back when root is an object instead of array');

    // 3. Array of numbers/booleans/null
    fs.writeFileSync(path.join(hiveRoot, 'projects.json'), JSON.stringify([123, true, null]), 'utf8');
    assert.deepEqual(getValidProjects(hiveRoot), VALID_PROJECTS, 'Should fall back when elements are not strings');

    // 4. Array containing empty or whitespace-only strings
    fs.writeFileSync(path.join(hiveRoot, 'projects.json'), JSON.stringify(['CustomApp', '', '   ']), 'utf8');
    assert.deepEqual(getValidProjects(hiveRoot), VALID_PROJECTS, 'Should fall back when array contains empty strings');

    // 5. Empty array
    fs.writeFileSync(path.join(hiveRoot, 'projects.json'), JSON.stringify([]), 'utf8');
    assert.deepEqual(getValidProjects(hiveRoot), VALID_PROJECTS, 'Should fall back when array is empty');
  } finally {
    rmTree(dir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. createCard: added project accepted, unknown refused, fallback on missing/malformed
// ─────────────────────────────────────────────────────────────────────────────

test('createCard accepts added project from <hive>/projects.json and refuses unknown project', () => {
  const { dir, hiveRoot, outboxDir } = tmpHive();
  try {
    fs.writeFileSync(path.join(hiveRoot, 'projects.json'), JSON.stringify(['CustomApp', 'Camp']), 'utf8');

    // Added project: accepted
    const resAdded = createCard({
      title: 'Setup CustomApp pipeline',
      assignee: 'quince-mvnvoaig',
      project: 'CustomApp',
      hiveRoot,
      outboxDir
    });
    assert.equal(resAdded.ok, true, `Expected CustomApp to be accepted: ${resAdded.error}`);
    assert.equal(resAdded.createPayload?.body?.project, 'CustomApp');

    // Bundled project not in projects.json: refused when file is present
    const resOmitted = createCard({
      title: 'Touch GammaGame',
      assignee: 'quince-mvnvoaig',
      project: 'GammaGame',
      hiveRoot,
      outboxDir
    });
    assert.equal(resOmitted.ok, false, 'Project not in projects.json must be refused');
    assert.match(resOmitted.error, /GammaGame.*Must be one of/i);

    // Completely unknown project: refused
    const resUnknown = createCard({
      title: 'Mystery task',
      assignee: 'quince-mvnvoaig',
      project: 'UnknownProject',
      hiveRoot,
      outboxDir
    });
    assert.equal(resUnknown.ok, false);
    assert.match(resUnknown.error, /UnknownProject.*Must be one of/i);
  } finally {
    rmTree(dir);
  }
});

test('createCard falls back to bundled VALID_PROJECTS when projects.json is missing or malformed', () => {
  const { dir, hiveRoot, outboxDir } = tmpHive();
  try {
    // Missing file: bundled accepted, unknown refused
    const resMissingBundled = createCard({
      title: 'General task',
      assignee: 'quince-mvnvoaig',
      project: 'General',
      hiveRoot,
      outboxDir
    });
    assert.equal(resMissingBundled.ok, true);

    const resMissingCustom = createCard({
      title: 'Custom task',
      assignee: 'quince-mvnvoaig',
      project: 'CustomApp',
      hiveRoot,
      outboxDir
    });
    assert.equal(resMissingCustom.ok, false);

    // Malformed file: bundled accepted, custom refused
    fs.writeFileSync(path.join(hiveRoot, 'projects.json'), '{ broken json', 'utf8');
    const resMalformedBundled = createCard({
      title: 'General task with malformed projects.json',
      assignee: 'quince-mvnvoaig',
      project: 'General',
      hiveRoot,
      outboxDir
    });
    assert.equal(resMalformedBundled.ok, true);

    const resMalformedCustom = createCard({
      title: 'Custom task with malformed projects.json',
      assignee: 'quince-mvnvoaig',
      project: 'CustomApp',
      hiveRoot,
      outboxDir
    });
    assert.equal(resMalformedCustom.ok, false);
  } finally {
    rmTree(dir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. patchCard: added project accepted, unknown refused, fallback
// ─────────────────────────────────────────────────────────────────────────────

test('patchCard validates project against <hive>/projects.json and falls back on missing/malformed', () => {
  const { dir, hiveRoot, outboxDir } = tmpHive();
  try {
    fs.writeFileSync(path.join(hiveRoot, 'projects.json'), JSON.stringify(['CustomApp', 'Camp']), 'utf8');

    // Added project: accepted
    const resAdded = patchCard({
      id: 'card-001',
      project: 'CustomApp',
      hiveRoot,
      outboxDir
    });
    assert.equal(resAdded.ok, true, `Expected patchCard to accept CustomApp: ${resAdded.error}`);
    assert.equal(resAdded.patchPayload?.body?.project, 'CustomApp');

    // Project not in projects.json: refused
    const resOmitted = patchCard({
      id: 'card-001',
      project: 'GammaGame',
      hiveRoot,
      outboxDir
    });
    assert.equal(resOmitted.ok, false);
    assert.match(resOmitted.error, /GammaGame.*Must be one of/i);

    // Corrupt file: falls back to bundled VALID_PROJECTS
    fs.writeFileSync(path.join(hiveRoot, 'projects.json'), 'not json', 'utf8');
    const resFallback = patchCard({
      id: 'card-001',
      project: 'General',
      hiveRoot,
      outboxDir
    });
    assert.equal(resFallback.ok, true);

    const resCustomFallback = patchCard({
      id: 'card-001',
      project: 'CustomApp',
      hiveRoot,
      outboxDir
    });
    assert.equal(resCustomFallback.ok, false);
  } finally {
    rmTree(dir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. dispatchTask: validates project against <hive>/projects.json
// ─────────────────────────────────────────────────────────────────────────────

test('dispatchTask validates project against <hive>/projects.json and falls back on missing/malformed', () => {
  const { dir, hiveRoot, outboxDir } = tmpHive();
  try {
    fs.writeFileSync(path.join(hiveRoot, 'projects.json'), JSON.stringify(['CustomApp', 'Camp']), 'utf8');

    // Dispatched existing card with string ID + project
    const resStringCard = dispatchTask({
      card: 'card-100',
      project: 'CustomApp',
      assignee: 'quince-mvnvoaig',
      contract: '## Contract\n- OBJECTIVE: x\n- OUTPUT: y\n- TOOLS: z\n- BOUNDARIES: w',
      hiveRoot,
      outboxDir
    });
    assert.equal(resStringCard.ok, true, `Expected dispatchTask to accept CustomApp: ${resStringCard.error}`);

    // Dispatched new card with object + project
    const resNewCard = dispatchTask({
      card: { id: 'card-200', title: 'New project card', project: 'CustomApp' },
      assignee: 'quince-mvnvoaig',
      contract: '## Contract\n- OBJECTIVE: x\n- OUTPUT: y\n- TOOLS: z\n- BOUNDARIES: w',
      hiveRoot,
      outboxDir
    });
    assert.equal(resNewCard.ok, true, `Expected dispatchTask to accept CustomApp on new card: ${resNewCard.error}`);

    // Unknown project refused
    const resUnknown = dispatchTask({
      card: 'card-100',
      project: 'UnknownProject',
      assignee: 'quince-mvnvoaig',
      contract: 'test',
      hiveRoot,
      outboxDir
    });
    assert.equal(resUnknown.ok, false);
    assert.match(resUnknown.error, /UnknownProject.*Must be one of/i);

    // Malformed projects.json falls back to bundled
    fs.writeFileSync(path.join(hiveRoot, 'projects.json'), '[ invalid', 'utf8');
    const resFallback = dispatchTask({
      card: 'card-100',
      project: 'General',
      assignee: 'quince-mvnvoaig',
      contract: 'test',
      hiveRoot,
      outboxDir
    });
    assert.equal(resFallback.ok, true, 'Should fall back to bundled projects and accept General');
  } finally {
    rmTree(dir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. writeProposal & handleProposeMcpCall: card proposals validation
// ─────────────────────────────────────────────────────────────────────────────

test('writeProposal validates project against <hive>/projects.json and falls back on missing/malformed', () => {
  const { dir, hiveRoot } = tmpHive();
  try {
    fs.writeFileSync(path.join(hiveRoot, 'projects.json'), JSON.stringify(['CustomApp', 'Camp']), 'utf8');

    // Added project: accepted
    const resAdded = writeProposal(hiveRoot, {
      title: 'Add widget to CustomApp',
      description: 'Needed for customer workflow',
      project: 'CustomApp'
    }, '/src/test');
    assert.equal(resAdded.ok, true, `Expected writeProposal to accept CustomApp: ${resAdded.error}`);

    // Unknown project: refused
    const resUnknown = writeProposal(hiveRoot, {
      title: 'Task for unknown',
      description: 'Desc',
      project: 'UnknownProject'
    }, '/src/test');
    assert.equal(resAdded.ok, true);
    assert.equal(resUnknown.ok, false);
    assert.match(resUnknown.error, /project must be one of/i);

    // Malformed projects.json falls back to bundled VALID_PROJECTS
    fs.writeFileSync(path.join(hiveRoot, 'projects.json'), '{ broken', 'utf8');
    const resFallback = writeProposal(hiveRoot, {
      title: 'General proposal with malformed file',
      description: 'Desc',
      project: 'General'
    }, '/src/test');
    assert.equal(resFallback.ok, true, 'Should fall back to bundled projects and accept General');

    const resFallbackCustom = writeProposal(hiveRoot, {
      title: 'Custom proposal with malformed file',
      description: 'Desc',
      project: 'CustomApp'
    }, '/src/test');
    assert.equal(resFallbackCustom.ok, false, 'CustomApp should be refused when falling back to bundled');
  } finally {
    rmTree(dir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. handleCampMcpCall: uses context.hiveRoot for project validation
// ─────────────────────────────────────────────────────────────────────────────

test('handleCampMcpCall uses context.hiveRoot for project validation on create_card and patch_card', () => {
  const { dir, hiveRoot, outboxDir } = tmpHive();
  try {
    fs.writeFileSync(path.join(hiveRoot, 'projects.json'), JSON.stringify(['CustomApp', 'Camp']), 'utf8');

    // create_card through MCP call with CustomApp
    const mcpCreate = handleCampMcpCall('create_card', {
      title: 'Created via MCP call',
      assignee: 'quince-mvnvoaig',
      project: 'CustomApp'
    }, { hiveRoot, agentId: 'boss', outboxDir });
    assert.equal(mcpCreate.isError, undefined, `Expected create_card via MCP to succeed: ${mcpCreate.content?.[0]?.text}`);

    // create_card through MCP call with unknown project
    const mcpCreateUnknown = handleCampMcpCall('create_card', {
      title: 'Created via MCP call unknown',
      assignee: 'quince-mvnvoaig',
      project: 'UnknownProject'
    }, { hiveRoot, agentId: 'boss', outboxDir });
    assert.equal(mcpCreateUnknown.isError, true);
    assert.match(mcpCreateUnknown.content[0].text, /UnknownProject.*Must be one of/i);

    // patch_card through MCP call with CustomApp
    const mcpPatch = handleCampMcpCall('patch_card', {
      id: 'card-999',
      project: 'CustomApp'
    }, { hiveRoot, agentId: 'boss', outboxDir });
    assert.equal(mcpPatch.isError, undefined, `Expected patch_card via MCP to succeed: ${mcpPatch.content?.[0]?.text}`);

    // patch_card through MCP call with unknown project
    const mcpPatchUnknown = handleCampMcpCall('patch_card', {
      id: 'card-999',
      project: 'UnknownProject'
    }, { hiveRoot, agentId: 'boss', outboxDir });
    assert.equal(mcpPatchUnknown.isError, true);
    assert.match(mcpPatchUnknown.content[0].text, /UnknownProject.*Must be one of/i);
  } finally {
    rmTree(dir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. MCP Tool schemas: getCampMcpTools & getProposeMcpTools reflect projects.json
// ─────────────────────────────────────────────────────────────────────────────

test('getCampMcpTools and getProposeMcpTools dynamically build project enum from <hive>/projects.json', () => {
  assert.equal(typeof getCampMcpTools, 'function', 'getCampMcpTools must be exported as a function');
  assert.equal(typeof getProposeMcpTools, 'function', 'getProposeMcpTools must be exported as a function');

  const { dir, hiveRoot } = tmpHive();
  try {
    const customProjects = ['AlphaGame', 'BetaService'];
    fs.writeFileSync(path.join(hiveRoot, 'projects.json'), JSON.stringify(customProjects), 'utf8');

    // camp MCP tools
    const campTools = getCampMcpTools(hiveRoot);
    const createTool = campTools.find((t) => t.name === 'create_card');
    const patchTool = campTools.find((t) => t.name === 'patch_card');
    const dispatchTool = campTools.find((t) => t.name === 'dispatch');

    assert.ok(createTool, 'create_card tool schema must be present');
    assert.ok(patchTool, 'patch_card tool schema must be present');
    assert.ok(dispatchTool, 'dispatch tool schema must be present');

    assert.deepEqual(createTool.inputSchema.properties.project.enum, customProjects);
    assert.deepEqual(patchTool.inputSchema.properties.project.enum, customProjects);
    assert.deepEqual(dispatchTool.inputSchema.properties.project.enum, customProjects);

    // propose MCP tools
    const proposeTools = getProposeMcpTools(hiveRoot);
    const proposeTool = proposeTools.find((t) => t.name === 'propose_card');
    assert.ok(proposeTool, 'propose_card tool schema must be present');
    assert.deepEqual(proposeTool.inputSchema.properties.project.enum, customProjects);

    // Missing projects.json falls back to bundled VALID_PROJECTS enum
    const fallbackCampTools = getCampMcpTools();
    const fallbackCreate = fallbackCampTools.find((t) => t.name === 'create_card');
    assert.deepEqual(fallbackCreate.inputSchema.properties.project.enum, VALID_PROJECTS);

    const fallbackProposeTools = getProposeMcpTools();
    const fallbackPropose = fallbackProposeTools.find((t) => t.name === 'propose_card');
    assert.deepEqual(fallbackPropose.inputSchema.properties.project.enum, VALID_PROJECTS);
  } finally {
    rmTree(dir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Environment variable HIVE_ROOT fallback
// ─────────────────────────────────────────────────────────────────────────────

test('operations respect process.env.HIVE_ROOT when hiveRoot option is omitted', () => {
  const { dir, hiveRoot, outboxDir } = tmpHive();
  const oldEnv = process.env.HIVE_ROOT;
  try {
    process.env.HIVE_ROOT = hiveRoot;
    fs.writeFileSync(path.join(hiveRoot, 'projects.json'), JSON.stringify(['EnvProject']), 'utf8');

    // createCard without explicit hiveRoot option
    const resCreate = createCard({
      title: 'Created using env HIVE_ROOT',
      assignee: 'quince-mvnvoaig',
      project: 'EnvProject',
      outboxDir
    });
    assert.equal(resCreate.ok, true, `Expected EnvProject to be accepted via process.env.HIVE_ROOT: ${resCreate.error}`);

    // patchCard without explicit hiveRoot option
    const resPatch = patchCard({
      id: 'card-env-1',
      project: 'EnvProject',
      outboxDir
    });
    assert.equal(resPatch.ok, true, `Expected EnvProject to be accepted via process.env.HIVE_ROOT: ${resPatch.error}`);

    // Tool schemas without explicit hiveRoot
    const campTools = getCampMcpTools();
    const createTool = campTools.find((t) => t.name === 'create_card');
    assert.deepEqual(createTool.inputSchema.properties.project.enum, ['EnvProject']);
  } finally {
    if (oldEnv !== undefined) {
      process.env.HIVE_ROOT = oldEnv;
    } else {
      delete process.env.HIVE_ROOT;
    }
    rmTree(dir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. PROTOCOL_BOSS_MD in hive.ts points to projects.json
// ─────────────────────────────────────────────────────────────────────────────

test('PROTOCOL_BOSS_MD in hive.ts points to projects.json instead of repeating hardcoded list', () => {
  const hiveTsPath = path.join(__dirname, '..', 'src', 'main', 'hive.ts');
  const hiveTs = fs.readFileSync(hiveTsPath, 'utf8');

  // Match PROTOCOL_BOSS_MD constant block
  const match = hiveTs.match(/const PROTOCOL_BOSS_MD = `([\s\S]*?)`;/);
  assert.ok(match, 'PROTOCOL_BOSS_MD constant should be defined in src/main/hive.ts');
  const protoBoss = match[1];

  // Must reference projects.json (e.g., projects.json or <hive>/projects.json)
  assert.match(
    protoBoss,
    /projects\.json/,
    'PROTOCOL_BOSS_MD must reference projects.json for valid project names'
  );

  // Must not hardcode the old compiled list of project names
  assert.doesNotMatch(
    protoBoss,
    /GammaGame, Alpha, DeltaGame, Camp/,
    'PROTOCOL_BOSS_MD must not contain the hardcoded list of projects'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. No create-card / patch-card files leaked into process.cwd()
// ─────────────────────────────────────────────────────────────────────────────

test.after(() => {
  const currentLeaked = fs
    .readdirSync(process.cwd())
    .filter((f) => (f.endsWith('-create-card.json') || /-create-card.*\.json$/.test(f)) && !initialCwdCreateCardFiles.has(f));
  assert.deepEqual(
    currentLeaked,
    [],
    `Expected cwd to gain no *-create-card.json files after the run, but found: ${currentLeaked.join(', ')}`
  );
});

test('cwd gains no *-create-card.json files after the run', () => {
  const leaked = fs
    .readdirSync(process.cwd())
    .filter((f) => (f.endsWith('-create-card.json') || /-create-card.*\.json$/.test(f)) && !initialCwdCreateCardFiles.has(f));
  assert.deepEqual(
    leaked,
    [],
    `Expected cwd to gain no *-create-card.json files after the run, but found: ${leaked.join(', ')}`
  );
});
