'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');

const {
  parseCodexRollout,
  ingestAgyUsage,
  parseCostLedger,
  summarizeUsageLedger,
  usageLedgerTable
} = loadTs('src/main/usageLedger.ts');

// Sample real-shaped Codex rollout lines
function codexRollout(turns = 1, opts = {}) {
  const model = opts.model || 'gpt-6-luna';
  const sessionId = opts.sessionId || '01a18433-b5c1-7172-9763-59946175f5ff';
  const lines = [
    JSON.stringify({
      timestamp: '2026-10-28T20:29:03.875Z',
      type: 'session_meta',
      payload: { session_id: sessionId, id: sessionId, cwd: '/home/user/workspace' }
    }),
    JSON.stringify({
      timestamp: '2026-10-28T20:29:05.053Z',
      type: 'turn_context',
      payload: { model, turn_id: 'turn-1' }
    })
  ];

  for (let i = 1; i <= turns; i++) {
    lines.push(
      JSON.stringify({
        timestamp: `2026-10-28T20:29:0${i + 5}.000Z`,
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 10000 * i,
              cached_input_tokens: 5000 * i,
              cache_write_input_tokens: 0,
              output_tokens: 200 * i,
              reasoning_output_tokens: 50 * i,
              total_tokens: 10200 * i
            },
            last_token_usage: {
              input_tokens: 10000,
              cached_input_tokens: 5000,
              cache_write_input_tokens: 0,
              output_tokens: 200,
              total_tokens: 10200
            }
          }
        }
      })
    );
  }
  return lines.join('\n');
}

// Sample real-shaped Claude cost-ledger.jsonl lines
function costLedgerLine(agent, session, input, output, cacheRead, cacheCreation, usd, model = 'claude-opus-5-5') {
  return JSON.stringify({
    agent_id: agent,
    session_id: session,
    ts: 1790179546644,
    input,
    output,
    cache_read: cacheRead,
    cache_creation: cacheCreation,
    model,
    usd
  });
}

test('parseCodexRollout extracts session tokens and model from single-turn rollout', () => {
  const text = codexRollout(1, { model: 'gpt-6-luna', sessionId: 'sess-codex-1' });
  const rec = parseCodexRollout(text, 'birch');
  assert.ok(rec);
  assert.equal(rec.agentId, 'birch');
  assert.equal(rec.sessionId, 'sess-codex-1');
  assert.equal(rec.engine, 'codex');
  assert.equal(rec.model, 'gpt-6-luna');
  assert.equal(rec.input, 10000);
  assert.equal(rec.output, 200);
  assert.equal(rec.cacheRead, 5000);
  assert.equal(rec.cacheCreation, 0);
  assert.equal(rec.totalTokens, 10200);
  assert.equal(rec.usd, null); // Codex has no USD cost in rollout
});

test('parseCodexRollout multi-turn uses the latest cumulative snapshot', () => {
  // 3 turns: turn 1 = 10000 in, turn 2 = 20000 in, turn 3 = 30000 in
  const text = codexRollout(3, { model: 'gpt-6.1-sol', sessionId: 'sess-codex-2' });
  const rec = parseCodexRollout(text, 'quince');
  assert.ok(rec);
  assert.equal(rec.input, 30000);
  assert.equal(rec.output, 600);
  assert.equal(rec.cacheRead, 15000);
  assert.equal(rec.totalTokens, 30600);
  assert.equal(rec.model, 'gpt-6.1-sol');
});

test('parseCodexRollout detects model from thread_settings_applied event', () => {
  const text = [
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'thread_settings_applied',
        thread_settings: { model: 'gpt-6-astra' }
      }
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 5000,
            cached_input_tokens: 1000,
            cache_write_input_tokens: 0,
            output_tokens: 150,
            total_tokens: 5150
          }
        }
      }
    })
  ].join('\n');

  const rec = parseCodexRollout(text, 'pine');
  assert.ok(rec);
  assert.equal(rec.model, 'gpt-6-astra');
  assert.equal(rec.totalTokens, 5150);
});

test('parseCodexRollout returns null for rollout without token_count', () => {
  const text = JSON.stringify({ type: 'session_meta', payload: { id: 'empty' } });
  assert.equal(parseCodexRollout(text, 'quince'), null);
});

test('parseCodexRollout skips malformed JSON lines cleanly', () => {
  const text = 'not json\n{bad\n' + codexRollout(1);
  const rec = parseCodexRollout(text, 'willow');
  assert.ok(rec);
  assert.equal(rec.input, 10000);
});

test('ingestAgyUsage maps conversation totals to an agy UsageRecord', () => {
  const totals = { input: 255817, output: 14473, cacheRead: 2092086 };
  const rec = ingestAgyUsage('hazel', totals, { sessionId: 'agy-conv-1' });
  assert.equal(rec.agentId, 'hazel');
  assert.equal(rec.sessionId, 'agy-conv-1');
  assert.equal(rec.engine, 'agy');
  assert.equal(rec.input, 255817);
  assert.equal(rec.output, 14473);
  assert.equal(rec.cacheRead, 2092086);
  assert.equal(rec.cacheCreation, 0);
  assert.equal(rec.totalTokens, 255817 + 14473 + 2092086);
  assert.equal(rec.usd, null);
});

test('ingestAgyUsage classifies pool-specific engines by model', () => {
  const totals = { input: 100, output: 50, cacheRead: 200 };
  const claudePool = ingestAgyUsage('a1', totals, { model: 'claude-opus-5-5-high' });
  assert.equal(claudePool.engine, 'agy-claude');

  const argonPool = ingestAgyUsage('a2', totals, { model: 'gemini-4-argon-medium' });
  assert.equal(argonPool.engine, 'agy-argon');

  const flashDefault = ingestAgyUsage('a3', totals, { model: 'gemini-3.8-flash-high' });
  assert.equal(flashDefault.engine, 'agy');
});

test('parseCostLedger parses Claude lines and dedupes multiple snapshots of same session', () => {
  const text = [
    costLedgerLine('god', 'sess-claude-1', 1000, 500, 20000, 5000, 0.25),
    costLedgerLine('god', 'sess-claude-1', 1500, 800, 30000, 6000, 0.45), // updated snapshot
    costLedgerLine('god', 'sess-claude-2', 500, 200, 10000, 2000, 0.10)
  ].join('\n');

  const records = parseCostLedger(text);
  assert.equal(records.length, 2);

  const s1 = records.find((r) => r.sessionId === 'sess-claude-1');
  assert.ok(s1);
  assert.equal(s1.agentId, 'god');
  assert.equal(s1.engine, 'claude');
  assert.equal(s1.input, 1500);
  assert.equal(s1.output, 800);
  assert.equal(s1.cacheRead, 30000);
  assert.equal(s1.cacheCreation, 6000);
  assert.equal(s1.totalTokens, 1500 + 800 + 30000 + 6000);
  assert.equal(s1.usd, 0.45);

  const s2 = records.find((r) => r.sessionId === 'sess-claude-2');
  assert.ok(s2);
  assert.equal(s2.input, 500);
  assert.equal(s2.usd, 0.10);
});

test('summarizeUsageLedger aggregates per agent, per engine', () => {
  const codexText1 = codexRollout(1, { model: 'gpt-6-luna', sessionId: 'c-1' }); // in 10000, out 200, cache 5000, total 10200
  const codexText2 = codexRollout(2, { model: 'gpt-6-luna', sessionId: 'c-2' }); // in 20000, out 400, cache 10000, total 20400
  const claudeText = [
    costLedgerLine('quince', 'cl-1', 5000, 500, 40000, 10000, 0.50),
    costLedgerLine('god', 'cl-2', 2000, 200, 15000, 3000, 0.20)
  ].join('\n');

  const rows = summarizeUsageLedger({
    codexRollouts: [
      { agentId: 'birch', text: codexText1 },
      { agentId: 'birch', text: codexText2 }, // 2nd session for birch
      { agentId: 'quince', text: codexText1 } // quince also ran codex
    ],
    agyConversations: [
      { agentId: 'hazel', totals: { input: 50000, output: 2000, cacheRead: 100000 } }
    ],
    costLedgerText: claudeText
  });

  // Expected rows:
  // - birch (codex): in 30000, out 600, cacheRead 15000, cacheCreation 0, total 30600
  // - quince (codex): in 10000, out 200, cacheRead 5000, cacheCreation 0, total 10200
  // - quince (claude): in 5000, out 500, cacheRead 40000, cacheCreation 10000, total 55500, usd 0.50
  // - hazel (agy): in 50000, out 2000, cacheRead 100000, cacheCreation 0, total 152000
  // - god (claude): in 2000, out 200, cacheRead 15000, cacheCreation 3000, total 20200, usd 0.20

  assert.equal(rows.length, 5);

  const bulbaCodex = rows.find((r) => r.agentId === 'birch' && r.engine === 'codex');
  assert.ok(bulbaCodex);
  assert.equal(bulbaCodex.input, 30000);
  assert.equal(bulbaCodex.output, 600);
  assert.equal(bulbaCodex.cacheRead, 15000);
  assert.equal(bulbaCodex.cacheCreation, 0);
  assert.equal(bulbaCodex.totalTokens, 30600);
  assert.equal(bulbaCodex.usd, null);

  const quinceCodex = rows.find((r) => r.agentId === 'quince' && r.engine === 'codex');
  assert.ok(quinceCodex);
  assert.equal(quinceCodex.totalTokens, 10200);

  const quinceClaude = rows.find((r) => r.agentId === 'quince' && r.engine === 'claude');
  assert.ok(quinceClaude);
  assert.equal(quinceClaude.input, 5000);
  assert.equal(quinceClaude.cacheCreation, 10000);
  assert.equal(quinceClaude.usd, 0.50);

  const hazelAgy = rows.find((r) => r.agentId === 'hazel' && r.engine === 'agy');
  assert.ok(hazelAgy);
  assert.equal(hazelAgy.totalTokens, 152000);

  // Rows sorted by totalTokens descending
  for (let i = 0; i < rows.length - 1; i++) {
    assert.ok(rows[i].totalTokens >= rows[i + 1].totalTokens, `row ${i} totalTokens >= row ${i + 1}`);
  }
});

test('usageLedgerTable renders empty case', () => {
  assert.equal(usageLedgerTable([]), 'No usage recorded.');
});

test('usageLedgerTable formats markdown table with columns and formatted numbers', () => {
  const rows = [
    {
      agentId: 'hazel',
      engine: 'agy',
      input: 50000,
      output: 2000,
      cacheRead: 100000,
      cacheCreation: 0,
      totalTokens: 152000,
      usd: null
    },
    {
      agentId: 'god',
      engine: 'claude',
      input: 1247,
      output: 861,
      cacheRead: 111104,
      cacheCreation: 56760,
      totalTokens: 169972,
      usd: 0.49
    }
  ];

  const table = usageLedgerTable(rows);
  assert.match(table, /\| Agent \| Engine \| Input \| Output \| Cache Read \| Cache Write \| Total Tokens \| Cost \(USD\) \|/);
  assert.match(table, /\|---\|---\|---\|---\|---\|---\|---\|---\|/);
  assert.match(table, /\| hazel \| agy \| 50,000 \| 2,000 \| 100,000 \| 0 \| 152,000 \| - \|/);
  assert.match(table, /\| god \| claude \| 1,247 \| 861 \| 111,104 \| 56,760 \| 169,972 \| \$0\.49 \|/);
});
