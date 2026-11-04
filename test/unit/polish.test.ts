import { strict as assert } from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { agentChoices } from '../../src/agents/choices';
import { DEFAULT_PROFILES } from '../../src/agents/profiles';
import { describeSince, parseStatus } from '../../src/agents/status';
import { git } from '../../src/git/git';
import { deleteSession, nextSessionId, startSession } from '../../src/sessions/lifecycle';
import { Session } from '../../src/sessions/model';
import { SessionStore } from '../../src/sessions/store';
import { sumTotals } from '../../src/time/compute';
import { Ticket } from '../../src/tickets/source';
import { filterWork, groupWork } from '../../src/ui/group';
import { makeRepo } from './helpers/repo';

const MIN = 60_000;
const WB = path.join(__dirname, '..', '..', 'bin', 'wb.js');
const aider = { id: 'aider', label: 'Aider', startCmd: 'aider --message-file ${promptFile}' };
const profiles = [...DEFAULT_PROFILES, aider];

describe('polish', function () {
  this.timeout(20000);

  describe('agentChoices', () => {
    const ids = (cs: ReturnType<typeof agentChoices>) => cs.map((c) => c.profile?.id ?? 'none');

    it('puts the default first, then the rest in profile order, and "no agent" last', () => {
      const cs = agentChoices(profiles, 'claude', undefined, false);
      assert.deepEqual(ids(cs), ['claude', 'codex', 'aider', 'none']);
      assert.equal(cs[0].description, 'default');
    });

    it('puts the agent last used on this ticket second, labelled', () => {
      const cs = agentChoices(profiles, 'claude', 'aider', false);
      assert.deepEqual(ids(cs), ['claude', 'aider', 'codex', 'none']);
      assert.equal(cs[1].description, 'last used on this ticket');
    });

    it('does not label the default twice when it was also last used', () => {
      const cs = agentChoices(profiles, 'codex', 'codex', false);
      assert.deepEqual(ids(cs), ['codex', 'claude', 'aider', 'none']);
      assert.equal(cs[0].description, 'default');
    });

    it('puts "no agent" first when agents should not start automatically', () => {
      assert.deepEqual(ids(agentChoices(profiles, 'claude', undefined, true)), ['none', 'claude', 'codex', 'aider']);
    });

    it('ignores a default or last-used id that is not a known profile', () => {
      assert.deepEqual(ids(agentChoices(profiles, 'gone', 'also-gone', false)), ['claude', 'codex', 'aider', 'none']);
    });
  });

  describe('nextSessionId (real git)', () => {
    let parent: string;
    let repo: string;
    let store: SessionStore;
    const ticket: Ticket = { source: 'Jira', id: 'PROJ-124', title: 'Fix login timeout', raw: {} };

    beforeEach(async () => {
      ({ parent, repo } = await makeRepo());
      store = new SessionStore(path.join(parent, 'state', 'sessions.json'));
    });
    afterEach(() => fs.rmSync(parent, { recursive: true, force: true }));

    it('predicts exactly the id startSession then uses, including after a deleted session kept its branch', async () => {
      assert.equal(await nextSessionId(repo, 'jira-proj-124', store), 'jira-proj-124-1');
      const first = await startSession({ repo, baseRef: 'main', store, ticket });
      assert.equal(await nextSessionId(repo, 'jira-proj-124', store), 'jira-proj-124-2');
      await deleteSession(store, first);
      const predicted = await nextSessionId(repo, 'jira-proj-124', store);
      const next = await startSession({ repo, baseRef: 'main', store, ticket });
      assert.equal(predicted, next.id);
      assert.equal(next.id, 'jira-proj-124-2');
    });

    it('skips a number whose folder exists even without a branch', async () => {
      fs.mkdirSync(path.join(parent, 'repo.worktrees', 'jira-proj-124-1'), { recursive: true });
      assert.equal(await nextSessionId(repo, 'jira-proj-124', store), 'jira-proj-124-2');
      await git(repo, ['status']);
    });
  });

  describe('wb.js keeps "since" for the current state', () => {
    let dir: string;
    let file: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-since-'));
      file = path.join(dir, 'status.json');
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    const hook = (event: string) =>
      spawnSync(process.execPath, [WB, 'hook', 'claude'], { input: JSON.stringify({ hook_event_name: event }), env: { ...process.env, WB_STATUS_FILE: file } });
    const read = () => parseStatus(fs.readFileSync(file, 'utf8'))!;

    it('sets since on the first write, keeps it while the state repeats, and resets it on a change', () => {
      hook('UserPromptSubmit');
      const first = read();
      assert.equal(first.since, first.at);

      fs.writeFileSync(file, JSON.stringify({ ...first, since: '2026-11-04T10:00:00.000Z' }));
      hook('PostToolUse'); // still working
      assert.equal(read().since, '2026-11-04T10:00:00.000Z');
      assert.notEqual(read().at, '2026-11-04T10:00:00.000Z');

      hook('Stop'); // working → done
      const done = read();
      assert.equal(done.state, 'done');
      assert.equal(done.since, done.at);
    });
  });

  describe('describeSince', () => {
    const now = new Date('2026-11-04T12:00:00Z');
    const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

    it('uses since, falling back to at for older status files', () => {
      assert.equal(describeSince({ state: 'working', at: ago(0), since: ago(4 * MIN) }, now), '4m');
      assert.equal(describeSince({ state: 'working', at: ago(7 * MIN) }, now), '7m');
    });

    it('says "now" under a minute and uses hours beyond 59 minutes', () => {
      assert.equal(describeSince({ state: 'done', at: ago(20_000) }, now), 'now');
      assert.equal(describeSince({ state: 'done', at: ago(65 * MIN) }, now), '1h 05m');
    });
  });

  describe('sumTotals', () => {
    it('adds each figure over tickets, and is zero for none', () => {
      const t = (y: number, a: number, e: number) => ({ yourMs: y * MIN, agentMs: a * MIN, elapsedMs: e * MIN });
      assert.deepEqual(sumTotals({ 'A:1': t(10, 20, 25), 'B:2': t(5, 0, 5) }), t(15, 20, 30));
      assert.deepEqual(sumTotals({}), t(0, 0, 0));
    });
  });

  describe('filterWork', () => {
    const cfg = { name: 'Jira', listCmd: 'x', map: { id: 'key', title: 'summary' } };
    const tk = (id: string, title: string, status?: string): Ticket => ({ source: 'Jira', id, title, status, raw: {} });
    const snap = { source: 'Jira', fetchedAt: 't', tickets: [tk('PROJ-1', 'Export CSV', 'To Do'), tk('PROJ-2', 'Login timeout', 'In Progress'), tk('PROJ-3', 'Dark mode', 'Done')] };
    const running: Session = { id: 'jira-proj-3-1', repo: '/r', worktree: '/w', branch: 'b', baseRef: 'main', createdAt: 't', ticket: { source: 'Jira', id: 'PROJ-3', title: 'Dark mode' } };
    const ids = (text: string) => filterWork(groupWork([cfg], [snap], [running]), text).sources[0].tickets.map((g) => g.ticket.id);

    it('matches id, title and status case-insensitively', () => {
      assert.deepEqual(ids('login'), ['PROJ-2', 'PROJ-3']);
      assert.deepEqual(ids('proj-1'), ['PROJ-1', 'PROJ-3']);
      assert.deepEqual(ids('in progress'), ['PROJ-2', 'PROJ-3']);
    });

    it('always keeps tickets with sessions, and filters nothing for empty or blank text', () => {
      assert.deepEqual(ids('zzz'), ['PROJ-3']);
      assert.deepEqual(ids('  '), ['PROJ-1', 'PROJ-2', 'PROJ-3']);
    });
  });
});
