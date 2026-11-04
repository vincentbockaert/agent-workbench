#!/usr/bin/env node
// Status writer for agent hooks. Plain Node, no dependencies, so any agent can call it.
//
//   wb.js hook claude            Claude Code hook; event JSON on stdin
//   wb.js hook codex <json>      Codex `notify`; payload JSON as last argument
//   wb.js status <state> [msg]   set a state directly (any other agent or script)
//
// Writes to $WB_STATUS_FILE, which the workbench sets in each session's agent terminal.
// Without it (e.g. a global hook outside a session) it does nothing. Hook mode always exits 0,
// so a problem here can never block the agent.
'use strict';

const fs = require('fs');
const path = require('path');

const STATES = ['working', 'needs-input', 'done', 'exited'];

// Returns the next status fields, or undefined for "no change".
function claudeState(input, prev) {
  const ids = input && input.session_id ? { agentSessionId: input.session_id } : {};
  switch (input && input.hook_event_name) {
    case 'UserPromptSubmit':
    case 'PostToolUse':
      return { state: 'working', ...ids };
    case 'Notification':
      // After the turn ended, a notification is only the idle reminder: still the user's turn, not a block.
      if (prev && prev.state === 'done') {
        return undefined;
      }
      return { state: 'needs-input', message: input.message, ...ids };
    case 'Stop':
    case 'SessionStart':
      return { state: 'done', ...ids };
    case 'SessionEnd':
      return { state: 'exited', ...ids };
    default:
      return undefined;
  }
}

function codexState(payload, _prev) {
  if (payload && payload.type === 'agent-turn-complete') {
    return { state: 'done', message: payload['last-assistant-message'] };
  }
  return undefined;
}

function readStatus(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function writeStatus(file, status) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(status));
  fs.renameSync(tmp, file);
}

function apply(file, next) {
  if (!next) {
    return;
  }
  const status = { state: next.state, at: new Date().toISOString() };
  if (next.message) {
    status.message = String(next.message).slice(0, 500);
  }
  if (next.agentSessionId) {
    status.agentSessionId = next.agentSessionId;
  }
  writeStatus(file, status);
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main(argv) {
  const file = process.env.WB_STATUS_FILE;
  const [mode, kind, ...rest] = argv;

  if (mode === 'status') {
    if (!STATES.includes(kind)) {
      process.stderr.write(`wb: unknown state "${kind}"; use one of: ${STATES.join(', ')}\n`);
      return 2;
    }
    if (file) {
      apply(file, { state: kind, message: rest.join(' ') || undefined });
    }
    return 0;
  }

  if (mode === 'hook') {
    try {
      const raw = kind === 'claude' ? readStdin() : rest[rest.length - 1];
      const input = JSON.parse(raw);
      if (file) {
        const prev = readStatus(file);
        apply(file, kind === 'claude' ? claudeState(input, prev) : kind === 'codex' ? codexState(input, prev) : undefined);
      }
    } catch (e) {
      process.stderr.write(`wb: ignored hook input (${e.message})\n`);
    }
    return 0;
  }

  process.stderr.write('usage: wb.js hook claude|codex [json] | wb.js status <state> [message]\n');
  return 2;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { STATES, claudeState, codexState, readStatus, writeStatus, main };
