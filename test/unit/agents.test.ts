import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { agentCommand, DEFAULT_PROFILES, expandCommand, mergeProfiles } from '../../src/agents/profiles';
import { SessionStore } from '../../src/sessions/store';

const vars = { sessionId: 'github-42-1', branch: 'wb/github-42-1' };

describe('agents', () => {
  describe('expandCommand', () => {
    it('fills ${promptFile} with the relative TASK.md path, plus ${sessionId} and ${branch}', () => {
      assert.equal(
        expandCommand('run ${promptFile} --name ${sessionId} on ${branch}', vars),
        'run .workbench/TASK.md --name github-42-1 on wb/github-42-1',
      );
    });

    it('replaces every occurrence', () => {
      assert.equal(expandCommand('${sessionId}/${sessionId}', vars), 'github-42-1/github-42-1');
    });

    it('rejects unknown placeholders by name', () => {
      assert.throws(() => expandCommand('x ${prompt}', vars), /unknown placeholder \$\{prompt\}/);
    });

    it('leaves shell variables without braces alone', () => {
      assert.equal(expandCommand('echo $HOME $env:USERPROFILE', vars), 'echo $HOME $env:USERPROFILE');
    });

    it('does not expand placeholders that appear inside inserted values', () => {
      assert.equal(expandCommand('${sessionId}', { ...vars, sessionId: '${branch}' }), '${branch}');
    });
  });

  describe('mergeProfiles', () => {
    it('provides claude and codex by default', () => {
      const { profiles, problems } = mergeProfiles([]);
      assert.deepEqual(profiles.map((p) => p.id), ['claude', 'codex']);
      assert.deepEqual(problems, []);
    });

    it('lets a user profile with the same id replace a default, keeping its position', () => {
      const mine = { id: 'claude', label: 'Claude (opus)', startCmd: 'claude --model opus' };
      const { profiles } = mergeProfiles([mine]);
      assert.deepEqual(profiles[0], mine);
      assert.equal(profiles.length, 2);
    });

    it('appends new user profiles', () => {
      const aider = { id: 'aider', label: 'Aider', startCmd: 'aider --message-file ${promptFile}' };
      assert.deepEqual(mergeProfiles([aider]).profiles.map((p) => p.id), ['claude', 'codex', 'aider']);
    });

    it('skips invalid entries and reports why', () => {
      const { profiles, problems } = mergeProfiles([{ id: 'x', label: 'X' }, 'nonsense', { id: 'ok', label: 'OK', startCmd: 'ok' }]);
      assert.deepEqual(profiles.map((p) => p.id), ['claude', 'codex', 'ok']);
      assert.equal(problems.length, 2);
      assert.match(problems[0], /x.*startCmd/);
    });

    it('rejects a profile whose command uses an unknown placeholder', () => {
      const { problems } = mergeProfiles([{ id: 'bad', label: 'Bad', startCmd: 'go ${nope}' }]);
      assert.match(problems[0], /bad.*\$\{nope\}/);
    });
  });

  describe('agentCommand', () => {
    it('defaults pass TASK.md by relative path, so no quoting of absolute paths is needed', () => {
      assert.ok(DEFAULT_PROFILES.length > 0);
      for (const p of DEFAULT_PROFILES) {
        const cmd = agentCommand(p, 'start', vars);
        assert.match(cmd, /\.workbench\/TASK\.md/, p.id);
        assert.ok(!cmd.includes('${'), `${p.id} left a placeholder`);
      }
    });

    it('resumes claude with --continue, which is scoped to the worktree folder', () => {
      const claude = DEFAULT_PROFILES.find((p) => p.id === 'claude')!;
      assert.equal(agentCommand(claude, 'resume', vars), 'claude --continue');
    });

    it('fails clearly when a profile has no resume command', () => {
      assert.throws(() => agentCommand({ id: 'x', label: 'X', startCmd: 'x' }, 'resume', vars), /X has no resume command/);
    });
  });

  describe('SessionStore.update', () => {
    let dir: string;
    beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-agents-'))));
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    const base = { id: 's-1', repo: '/r', worktree: '/w', branch: 'wb/s-1', baseRef: 'main', createdAt: 't' };

    it('merges the patch, persists it, and returns the updated session', () => {
      const file = path.join(dir, 'sessions.json');
      const store = new SessionStore(file);
      store.add(base);
      const updated = store.update('s-1', { agent: 'claude' });
      assert.deepEqual(updated, { ...base, agent: 'claude' });
      assert.deepEqual(new SessionStore(file).list(), [{ ...base, agent: 'claude' }]);
    });

    it('rejects an unknown session id', () => {
      const store = new SessionStore(path.join(dir, 'sessions.json'));
      assert.throws(() => store.update('nope', { agent: 'claude' }), /nope/);
    });
  });
});
