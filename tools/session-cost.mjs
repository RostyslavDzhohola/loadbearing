#!/usr/bin/env node
// What did a Claude Code session cost? Sums token usage from its transcript.
//   node tools/session-cost.mjs ~/.claude/projects/<project>/<session-id>.jsonl [--json]
// Subagent transcripts in the sibling <session-id>/ folder are included.
// Prices: USD per million tokens, from https://platform.claude.com/docs/en/about-claude/pricing
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PRICES = { // [input, 5m cache write, 1h cache write, cache read, output]
  'claude-fable-5-2': [8, 10, 16, 0.2, 40],
  'claude-fable-5-1': [10, 12.5, 20, 0.25, 50],
  'claude-opus-5-5': [4, 5, 8, 0.2, 20],
  'claude-sonnet-5-5': [2, 2.5, 4, 0.1, 10],
};

const file = process.argv[2];
if (!file) { console.error('usage: session-cost.mjs <session.jsonl> [--json]'); process.exit(1); }
const files = [file];
const side = file.replace(/\.jsonl$/, '');
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.jsonl')) files.push(p);
  }
};
if (existsSync(side)) walk(side);

// A streamed reply is logged several times with a growing usage block; the last copy per request wins.
const calls = new Map();
for (const f of files) for (const line of readFileSync(f, 'utf8').split('\n')) {
  if (!line) continue;
  let d; try { d = JSON.parse(line); } catch { continue; }
  const u = d.message?.usage;
  if (d.type === 'assistant' && u) calls.set(`${d.message.id}:${d.requestId}`, { model: d.message.model, u });
}

const models = {};
for (const { model, u } of calls.values()) {
  const m = (models[model] ||= { calls: 0, input: 0, write5m: 0, write1h: 0, cacheRead: 0, output: 0 });
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  m.calls++;
  m.input += u.input_tokens ?? 0;
  m.write1h += w1h;
  m.write5m += (u.cache_creation_input_tokens ?? 0) - w1h;
  m.cacheRead += u.cache_read_input_tokens ?? 0;
  m.output += u.output_tokens ?? 0;
}

let tokens = 0, cost = 0;
const unpriced = [];
for (const [model, m] of Object.entries(models)) {
  m.tokens = m.input + m.write5m + m.write1h + m.cacheRead + m.output;
  const p = PRICES[model];
  m.cost = p ? (m.input * p[0] + m.write5m * p[1] + m.write1h * p[2] + m.cacheRead * p[3] + m.output * p[4]) / 1e6 : null;
  tokens += m.tokens;
  if (p) cost += m.cost; else unpriced.push(model);
}
const result = { files: files.length, tokens, cost: +cost.toFixed(2), unpriced, models };
if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
else {
  for (const [model, m] of Object.entries(models)) {
    console.log(`${model}: ${m.calls} calls`);
    for (const k of ['input', 'write5m', 'write1h', 'cacheRead', 'output']) console.log(`  ${k.padEnd(10)} ${m[k].toLocaleString('en-US').padStart(12)}`);
    console.log(`  ${'cost'.padEnd(10)} ${(m.cost === null ? 'no price listed' : '$' + m.cost.toFixed(2)).padStart(12)}`);
  }
  console.log(`total: ${tokens.toLocaleString('en-US')} tokens · $${cost.toFixed(2)}${unpriced.length ? ` (unpriced: ${unpriced.join(', ')})` : ''}`);
}
