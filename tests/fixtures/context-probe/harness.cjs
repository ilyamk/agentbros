#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.CLAUDECODE) throw new Error('Nested Claude session guard was inherited');
if (process.env.PROBE_TEST_LOG) fs.appendFileSync(process.env.PROBE_TEST_LOG, JSON.stringify({ args, cwd: process.cwd() }) + '\n');
if (args.includes('--help')) {
  console.log(process.env.PROBE_TEST_MODE === 'bad-help' ? 'unsupported' : '--sandbox --ephemeral --json --allowedTools --tools --strict-mcp-config --mcp-config --setting-sources --no-session-persistence --output-format');
  process.exit(0);
}
if (args.includes('--version')) { console.log('fake-harness 1.0'); process.exit(0); }
if (process.env.PROBE_TEST_MODE === 'fail') process.exit(9);
const token = (file) => fs.readFileSync(file, 'utf8').match(/CANARY-[a-f0-9]{24}/g);
const root = token('AGENTS.md')[0];
const agent = token('.agents/agents/context-probe-canary.md')[0];
const [description, body] = token('.agents/skills/context-probe-canary/SKILL.md');
const emit = (value) => console.log(JSON.stringify(value));
if (args[0] === 'exec') {
  emit({ type: 'item.completed', item: { type: 'agent_message', text: root + ' ' + description } });
} else if (args.includes('Agent,Task') && process.env.PROBE_TEST_MODE !== 'no-child') {
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', id: 'child-1', input: { run_in_background: process.env.PROBE_TEST_MODE === 'background', subagent_type: process.env.PROBE_TEST_MODE === 'wrong-child' ? 'other' : 'context-probe-canary', prompt: process.env.PROBE_TEST_MODE === 'contaminated' ? root : 'List already-known canaries without tools.' } }] } });
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'child-1', content: [{ type: 'text', text: root + ' ' + agent }] }] } });
  emit({ type: 'result', result: body });
} else emit({ type: 'result', result: root + ' ' + description });
