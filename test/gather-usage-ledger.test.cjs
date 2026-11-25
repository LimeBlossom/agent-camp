'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

const {
  gatherUsageLedger,
  gatherWeeklyUsageLedger,
  gather7DayUsage,
  parseCodexRollout,
  summarizeUsageLedger
} = loadTs('src/main/usageLedger.ts');

function makeCodexRolloutContent({ agentId, sessionId, model = 'gpt-6.1-sol', input = 10000, output = 500, cacheRead = 4000 }) {
  return [
    JSON.stringify({
      timestamp: '2026-10-28T20:00:00.000Z',
      type: 'session_meta',
      payload: { session_id: sessionId, id: sessionId, cwd: `/home/user/workspace/${agentId}` }
    }),
    JSON.stringify({
      timestamp: '2026-10-28T20:00:01.000Z',
      type: 'turn_context',
      payload: { model, turn_id: 'turn-1' }
    }),
    JSON.stringify({
      timestamp: '2026-10-28T20:00:05.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: input,
            cached_input_tokens: cacheRead,
            cache_write_input_tokens: 0,
            output_tokens: output,
            total_tokens: input + output
          }
        }
      }
    })
  ].join('\n');
}

// Never let a test read the real ~/.codex or agy home: hive agents' own rollouts live there.
function emptyHomes(tmp) {
  return { userCodexHome: path.join(tmp, 'no-user-codex'), agyHome: path.join(tmp, 'no-agy') };
}

test('gatherUsageLedger: refuses to run without explicit engine homes', async () => {
  await assert.rejects(() => gatherUsageLedger({ hiveRoot: os.tmpdir(), nowMs: 0, days: 7 }), /userCodexHome and agyHome/);
});

test('gatherUsageLedger: returns empty array when directories and files are missing', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gather-usage-empty-'));
  try {
    const rows = await gatherUsageLedger({
      hiveRoot: path.join(tmp, 'nonexistent-hive'),
      agyHome: path.join(tmp, 'nonexistent-agy'),
      userCodexHome: path.join(tmp, 'nonexistent-codex'),
      nowMs: 1730419200000,
      days: 7
    });
    assert.deepEqual(rows, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('gatherUsageLedger: filters Claude cost-ledger to the 7-day window and dedupes sessions', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gather-usage-claude-'));
  try {
    const nowMs = 1730419200000; // 2026-10-31T20:00:00.000Z
    const dayMs = 86_400_000;
    const hiveRoot = path.join(tmp, 'hive');
    fs.mkdirSync(hiveRoot, { recursive: true });

    const lines = [
      // Old record from 10 days ago (outside 7-day window) -> MUST BE EXCLUDED
      JSON.stringify({
        agent_id: 'maple',
        session_id: 'sess-old',
        ts: nowMs - 10 * dayMs,
        input: 100000,
        output: 5000,
        cache_read: 200000,
        cache_creation: 0,
        model: 'claude-sonnet-5-5',
        usd: 1.50
      }),
      // Recent session snapshot 1 (2 days ago)
      JSON.stringify({
        agent_id: 'maple',
        session_id: 'sess-recent-1',
        ts: nowMs - 2 * dayMs,
        input: 10000,
        output: 500,
        cache_read: 20000,
        cache_creation: 100,
        model: 'claude-sonnet-5-5',
        usd: 0.15
      }),
      // Recent session snapshot 2 (1 day ago, higher cumulative numbers -> wins for sess-recent-1)
      JSON.stringify({
        agent_id: 'maple',
        session_id: 'sess-recent-1',
        ts: nowMs - 1 * dayMs,
        input: 25000,
        output: 1200,
        cache_read: 50000,
        cache_creation: 200,
        model: 'claude-sonnet-5-5',
        usd: 0.35
      }),
      // Another agent inside 7-day window (3 days ago)
      JSON.stringify({
        agent_id: 'birch',
        session_id: 'sess-bulba-1',
        ts: nowMs - 3 * dayMs,
        input: 8000,
        output: 400,
        cache_read: 12000,
        cache_creation: 0,
        model: 'claude-sonnet-5-5',
        usd: 0.10
      })
    ];
    fs.writeFileSync(path.join(hiveRoot, 'cost-ledger.jsonl'), lines.join('\n') + '\n');

    const rows = await gatherUsageLedger({ hiveRoot, ...emptyHomes(tmp), nowMs, days: 7 });

    assert.equal(rows.length, 2, 'should only have rows for maple and birch');
    const maple = rows.find((r) => r.agentId === 'maple');
    const bulba = rows.find((r) => r.agentId === 'birch');

    assert.ok(maple, 'maple must be present');
    assert.equal(maple.engine, 'claude');
    assert.equal(maple.input, 25000);
    assert.equal(maple.output, 1200);
    assert.equal(maple.cacheRead, 50000);
    assert.equal(maple.cacheCreation, 200);
    assert.equal(maple.totalTokens, 25000 + 1200 + 50000 + 200);
    assert.equal(maple.usd, 0.35);

    assert.ok(bulba, 'birch must be present');
    assert.equal(bulba.engine, 'claude');
    assert.equal(bulba.input, 8000);
    assert.equal(bulba.output, 400);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('gatherUsageLedger: gathers Codex rollouts per agent within 7-day window and ignores older rollouts', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gather-usage-codex-'));
  try {
    const nowMs = 1730419200000; // 2026-10-31
    const hiveRoot = path.join(tmp, 'hive');
    const agentDir = path.join(hiveRoot, 'agents', 'elm', '.codex', 'sessions');

    // 1. Recent rollout from 2 days ago (2026/10/29)
    const recentDir = path.join(agentDir, '2026', '10', '29');
    fs.mkdirSync(recentDir, { recursive: true });
    const recentPath = path.join(recentDir, 'rollout-2026-10-29T10-00-00-sess-recent-codex.jsonl');
    fs.writeFileSync(
      recentPath,
      makeCodexRolloutContent({
        agentId: 'elm',
        sessionId: 'sess-recent-codex',
        model: 'gpt-6.1-sol',
        input: 15000,
        output: 800,
        cacheRead: 6000
      })
    );
    const recentTime = (nowMs - 2 * 86_400_000) / 1000;
    fs.utimesSync(recentPath, recentTime, recentTime);

    // 2. Old rollout from 14 days ago (2026/10/17) -> MUST BE IGNORED
    const oldDir = path.join(agentDir, '2026', '10', '17');
    fs.mkdirSync(oldDir, { recursive: true });
    const oldPath = path.join(oldDir, 'rollout-2026-10-17T10-00-00-sess-old-codex.jsonl');
    fs.writeFileSync(
      oldPath,
      makeCodexRolloutContent({
        agentId: 'elm',
        sessionId: 'sess-old-codex',
        model: 'gpt-6.1-sol',
        input: 90000,
        output: 3000,
        cacheRead: 40000
      })
    );
    const oldTime = (nowMs - 14 * 86_400_000) / 1000;
    fs.utimesSync(oldPath, oldTime, oldTime);

    const rows = await gatherUsageLedger({ hiveRoot, ...emptyHomes(tmp), nowMs, days: 7 });

    assert.equal(rows.length, 1);
    const elm = rows[0];
    assert.equal(elm.agentId, 'elm');
    assert.equal(elm.engine, 'codex');
    assert.equal(elm.input, 15000);
    assert.equal(elm.output, 800);
    assert.equal(elm.cacheRead, 6000);
    assert.equal(elm.totalTokens, 15800);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('gatherUsageLedger: gathers Antigravity databases mapped via log.jsonl within 7-day window', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gather-usage-agy-'));
  try {
    const nowMs = 1730419200000; // 2026-10-31
    const dayMs = 86_400_000;
    const hiveRoot = path.join(tmp, 'hive');
    const agyHome = path.join(tmp, 'agy');
    fs.mkdirSync(hiveRoot, { recursive: true });
    fs.mkdirSync(path.join(agyHome, 'conversations'), { recursive: true });

    const recentSessionId = '01a19446-e50c-7fe0-a1cc-5bf1f1eda66b';
    const oldSessionId = '005af312-1d23-46a8-b57e-3ae079e9d75c';

    // 1. Create recent agy DB file placeholder
    const recentDbPath = path.join(agyHome, 'conversations', `${recentSessionId}.db`);
    fs.writeFileSync(recentDbPath, 'sqlite-dummy-recent');
    const recentTime = (nowMs - 3 * dayMs) / 1000;
    fs.utimesSync(recentDbPath, recentTime, recentTime);

    // 2. Create old agy DB file placeholder
    const oldDbPath = path.join(agyHome, 'conversations', `${oldSessionId}.db`);
    fs.writeFileSync(oldDbPath, 'sqlite-dummy-old');
    const oldTime = (nowMs - 12 * dayMs) / 1000;
    fs.utimesSync(oldDbPath, oldTime, oldTime);

    // 3. Write log.jsonl with session entries
    const logEntries = [
      JSON.stringify({ ts: nowMs - 12 * dayMs, kind: 'session', agentId: 'spruce', sessionId: oldSessionId }),
      JSON.stringify({ ts: nowMs - 3 * dayMs, kind: 'session', agentId: 'spruce', sessionId: recentSessionId })
    ];
    fs.writeFileSync(path.join(hiveRoot, 'log.jsonl'), logEntries.join('\n') + '\n');

    const fakeTotals = new Map([
      [recentDbPath, { input: 42000, output: 2100, cacheRead: 15000 }],
      [oldDbPath, { input: 88000, output: 4000, cacheRead: 30000 }]
    ]);

    const rows = await gatherUsageLedger({
      hiveRoot,
      userCodexHome: emptyHomes(tmp).userCodexHome,
      agyHome,
      nowMs,
      days: 7,
      readAgyTotals: (dbPath) => fakeTotals.get(dbPath) ?? null
    });

    assert.equal(rows.length, 1);
    const spruce = rows[0];
    assert.equal(spruce.agentId, 'spruce');
    assert.equal(spruce.engine, 'agy');
    assert.equal(spruce.input, 42000);
    assert.equal(spruce.output, 2100);
    assert.equal(spruce.cacheRead, 15000);
    assert.equal(spruce.totalTokens, 42000 + 2100 + 15000);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('gatherUsageLedger: unifies multiple agents and engines, sorted by totalTokens descending', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gather-usage-unified-'));
  try {
    const nowMs = 1730419200000;
    const dayMs = 86_400_000;
    const hiveRoot = path.join(tmp, 'hive');
    const agyHome = path.join(tmp, 'agy');
    fs.mkdirSync(hiveRoot, { recursive: true });
    fs.mkdirSync(path.join(agyHome, 'conversations'), { recursive: true });

    // Agent 1 (boss): Claude cost ledger (total ~100k tokens)
    fs.writeFileSync(
      path.join(hiveRoot, 'cost-ledger.jsonl'),
      JSON.stringify({
        agent_id: 'god',
        session_id: 'sess-god-1',
        ts: nowMs - 1 * dayMs,
        input: 40000,
        output: 5000,
        cache_read: 55000,
        cache_creation: 0,
        model: 'claude-sonnet-5-5',
        usd: 0.85
      }) + '\n'
    );

    // Agent 2 (elm): Codex rollout (total ~30k tokens)
    const elmDir = path.join(hiveRoot, 'agents', 'elm', '.codex', 'sessions', '2026', '10', '30');
    fs.mkdirSync(elmDir, { recursive: true });
    fs.writeFileSync(
      path.join(elmDir, 'rollout-2026-10-30T12-00-00-sess-elm.jsonl'),
      makeCodexRolloutContent({
        agentId: 'elm',
        sessionId: 'sess-elm',
        model: 'gpt-6.1-sol',
        input: 28000,
        output: 2000,
        cacheRead: 10000
      })
    );

    // Agent 3 (spruce): Antigravity db (total ~200k tokens)
    const agySessId = '01a19446-e50c-7fe0-a1cc-5bf1f1eda66b';
    const agyDbPath = path.join(agyHome, 'conversations', `${agySessId}.db`);
    fs.writeFileSync(agyDbPath, 'sqlite-dummy');
    fs.writeFileSync(
      path.join(hiveRoot, 'log.jsonl'),
      JSON.stringify({ ts: nowMs - 2 * dayMs, kind: 'session', agentId: 'spruce', sessionId: agySessId }) + '\n'
    );

    const rows = await gatherUsageLedger({
      hiveRoot,
      userCodexHome: emptyHomes(tmp).userCodexHome,
      agyHome,
      nowMs,
      days: 7,
      readAgyTotals: (p) => (p === agyDbPath ? { input: 150000, output: 10000, cacheRead: 40000 } : null)
    });

    assert.equal(rows.length, 3);
    // Busiest first: spruce (200k), god (100k), elm (30k)
    assert.equal(rows[0].agentId, 'spruce');
    assert.equal(rows[0].engine, 'agy');
    assert.equal(rows[0].totalTokens, 200000);

    assert.equal(rows[1].agentId, 'god');
    assert.equal(rows[1].engine, 'claude');
    assert.equal(rows[1].totalTokens, 100000);

    assert.equal(rows[2].agentId, 'elm');
    assert.equal(rows[2].engine, 'codex');
    assert.equal(rows[2].totalTokens, 30000);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('gatherUsageLedger: resilient against malformed files and torn lines', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gather-usage-resilience-'));
  try {
    const nowMs = 1730419200000;
    const hiveRoot = path.join(tmp, 'hive');
    fs.mkdirSync(hiveRoot, { recursive: true });

    // cost-ledger with torn lines
    fs.writeFileSync(
      path.join(hiveRoot, 'cost-ledger.jsonl'),
      ['{"agent_id":"broken", "ts":', '{"not_json":true', JSON.stringify({
        agent_id: 'survivor',
        session_id: 'sess-surv',
        ts: nowMs - 1000,
        input: 1000,
        output: 100,
        cache_read: 0,
        cache_creation: 0,
        model: 'claude-haiku-4-5',
        usd: 0.01
      }), ''].join('\n')
    );

    const rows = await gatherUsageLedger({ hiveRoot, ...emptyHomes(tmp), nowMs, days: 7 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].agentId, 'survivor');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('gatherWeeklyUsageLedger and gather7DayUsage aliases match gatherUsageLedger', () => {
  assert.equal(gatherWeeklyUsageLedger, gatherUsageLedger);
  assert.equal(gather7DayUsage, gatherUsageLedger);
});
