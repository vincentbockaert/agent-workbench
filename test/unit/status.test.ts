import { strict as assert } from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { claudeHookSettings, parseStatus, shouldNotify } from '../../src/agents/status';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const wb = require('../../bin/wb.js');
const WB = path.join(__dirname, '..', '..', 'bin', 'wb.js');

const done = { state: 'done', at: 't0' };
const working = { state: 'working', at: 't0' };

describe('status', function () {
  this.timeout(20000);

  describe('claudeState (hook event → state)', () => {
    it('marks prompt submission and finished tools as working', () => {
      assert.equal(wb.claudeState({ hook_event_name: 'UserPromptSubmit' }, done).state, 'working');
      assert.equal(wb.claudeState({ hook_event_name: 'PostToolUse' }, undefined).state, 'working');
    });

    it('marks a notification as needs-input, carrying its message', () => {
      const next = wb.claudeState({ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' }, working);
      assert.deepEqual([next.state, next.message], ['needs-input', 'Claude needs your permission to use Bash']);
    });

    it('ignores the idle reminder notification after the turn is done', () => {
      assert.equal(wb.claudeState({ hook_event_name: 'Notification', message: 'Claude is waiting for your input' }, done), undefined);
    });

    it('marks Stop and SessionStart as done (your turn), SessionEnd as exited', () => {
      assert.equal(wb.claudeState({ hook_event_name: 'Stop' }, working).state, 'done');
      assert.equal(wb.claudeState({ hook_event_name: 'SessionStart' }, undefined).state, 'done');
      assert.equal(wb.claudeState({ hook_event_name: 'SessionEnd' }, working).state, 'exited');
    });

    it('records the agent session id', () => {
      assert.equal(wb.claudeState({ hook_event_name: 'Stop', session_id: 'abc' }, working).agentSessionId, 'abc');
    });

    it('ignores unknown events', () => {
      assert.equal(wb.claudeState({ hook_event_name: 'PreCompact' }, working), undefined);
      assert.equal(wb.claudeState({}, working), undefined);
    });
  });

  describe('codexState (notify payload → state)', () => {
    it('marks a completed turn as done with the last assistant message', () => {
      const next = wb.codexState({ type: 'agent-turn-complete', 'last-assistant-message': 'All tests pass.' }, working);
      assert.deepEqual([next.state, next.message], ['done', 'All tests pass.']);
    });

    it('ignores other payloads', () => {
      assert.equal(wb.codexState({ type: 'something-else' }, working), undefined);
    });
  });

  describe('wb.js command line', () => {
    let dir: string;
    let file: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-status-'));
      file = path.join(dir, '.workbench', 'status.json');
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    const run = (args: string[], input?: string, env: Record<string, string> = { WB_STATUS_FILE: file }) =>
      spawnSync(process.execPath, [WB, ...args], { input, env: { ...process.env, ...env }, encoding: 'utf8' });

    it('writes the state from a Claude hook on stdin to $WB_STATUS_FILE', () => {
      const r = run(['hook', 'claude'], JSON.stringify({ hook_event_name: 'Notification', message: 'need ok', session_id: 's1' }));
      assert.equal(r.status, 0);
      const status = parseStatus(fs.readFileSync(file, 'utf8'));
      assert.equal(status?.state, 'needs-input');
      assert.equal(status?.message, 'need ok');
      assert.equal(status?.agentSessionId, 's1');
      assert.ok(!Number.isNaN(Date.parse(status!.at)));
    });

    it('uses the previous status for decisions (idle reminder after Stop changes nothing)', () => {
      run(['hook', 'claude'], JSON.stringify({ hook_event_name: 'Stop' }));
      run(['hook', 'claude'], JSON.stringify({ hook_event_name: 'Notification', message: 'waiting' }));
      assert.equal(parseStatus(fs.readFileSync(file, 'utf8'))?.state, 'done');
    });

    it('reads a Codex notify payload from the last argument', () => {
      const r = run(['hook', 'codex', JSON.stringify({ type: 'agent-turn-complete', 'last-assistant-message': 'Fixed.' })]);
      assert.equal(r.status, 0);
      assert.equal(parseStatus(fs.readFileSync(file, 'utf8'))?.state, 'done');
    });

    it('sets a state directly for any other agent or script', () => {
      assert.equal(run(['status', 'needs-input', 'pick a database']).status, 0);
      const status = parseStatus(fs.readFileSync(file, 'utf8'));
      assert.deepEqual([status?.state, status?.message], ['needs-input', 'pick a database']);
    });

    it('rejects an unknown state with a message listing the valid ones', () => {
      const r = run(['status', 'blocked']);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /working.*needs-input.*done.*exited/);
      assert.ok(!fs.existsSync(file));
    });

    it('does nothing and succeeds outside a workbench session (no WB_STATUS_FILE)', () => {
      const r = run(['hook', 'claude'], JSON.stringify({ hook_event_name: 'Stop' }), { WB_STATUS_FILE: '' });
      assert.equal(r.status, 0);
      assert.ok(!fs.existsSync(file));
    });

    it('never fails a hook on bad input, so the agent is never blocked', () => {
      assert.equal(run(['hook', 'claude'], 'not json').status, 0);
      assert.equal(run(['hook', 'codex', '{oops']).status, 0);
      assert.ok(!fs.existsSync(file));
    });
  });

  describe('parseStatus', () => {
    it('accepts a valid status', () => {
      assert.deepEqual(parseStatus('{"state":"working","at":"2026-11-04T10:00:00.000Z"}'), {
        state: 'working',
        at: '2026-11-04T10:00:00.000Z',
      });
    });

    it('rejects invalid JSON, unknown states and missing timestamps', () => {
      assert.equal(parseStatus('{'), undefined);
      assert.equal(parseStatus('{"state":"blocked","at":"t"}'), undefined);
      assert.equal(parseStatus('{"state":"working"}'), undefined);
      assert.equal(parseStatus('[]'), undefined);
    });
  });

  describe('shouldNotify', () => {
    it('notifies only when a session newly needs input', () => {
      assert.equal(shouldNotify(undefined, 'needs-input'), true);
      assert.equal(shouldNotify('working', 'needs-input'), true);
      assert.equal(shouldNotify('needs-input', 'needs-input'), false);
      assert.equal(shouldNotify('working', 'done'), false);
    });
  });

  describe('claudeHookSettings', () => {
    it('hooks every mapped event to wb.js with a quoted, forward-slash path', () => {
      const settings = claudeHookSettings('C:\\Program Files\\ext\\bin\\wb.js') as {
        hooks: Record<string, { hooks: { type: string; command: string }[] }[]>;
      };
      assert.deepEqual(Object.keys(settings.hooks).sort(), ['Notification', 'PostToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
      for (const [event, entries] of Object.entries(settings.hooks)) {
        assert.equal(entries[0].hooks[0].type, 'command', event);
        assert.equal(entries[0].hooks[0].command, 'node "C:/Program Files/ext/bin/wb.js" hook claude', event);
      }
    });
  });
});
