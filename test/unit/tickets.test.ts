import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describeAge, readSnapshot, refreshSource } from '../../src/tickets/snapshot';
import { fetchTickets, mapTickets, TicketSourceConfig } from '../../src/tickets/source';

// Stub commands are small node scripts: no network, no real tracker.
const fixtures = path.join(__dirname, '..', 'fixtures');
const printFile = (file: string) => `node "${path.join(fixtures, 'print-file.js')}" "${path.join(fixtures, file)}"`;

const github: TicketSourceConfig = {
  name: 'GitHub',
  listCmd: printFile('gh-issues.json'),
  map: { id: 'number', title: 'title', status: 'state', url: 'url' },
};

const jira: TicketSourceConfig = {
  name: 'Jira',
  listCmd: printFile('jira-search.json'),
  itemsPath: 'issues',
  map: { id: 'key', title: 'fields.summary', status: 'fields.status.name' },
};

describe('tickets', function () {
  this.timeout(20000);

  describe('mapTickets', () => {
    it('maps top-level fields and turns numeric ids into strings', () => {
      const [first] = mapTickets([{ number: 42, title: 'T', state: 'OPEN', url: 'u' }], github);
      assert.deepEqual(
        { ...first, raw: undefined },
        { source: 'GitHub', id: '42', title: 'T', status: 'OPEN', url: 'u', raw: undefined },
      );
    });

    it('follows dotted paths and itemsPath', () => {
      const tickets = mapTickets({ issues: [{ key: 'P-1', fields: { summary: 'S', status: { name: 'Done' } } }] }, jira);
      assert.equal(tickets[0].id, 'P-1');
      assert.equal(tickets[0].title, 'S');
      assert.equal(tickets[0].status, 'Done');
      assert.equal(tickets[0].url, undefined);
    });

    it('keeps the raw item so nothing from the tracker is lost', () => {
      const item = { number: 1, title: 'T', extra: { deep: true } };
      assert.deepEqual(mapTickets([item], github)[0].raw, item);
    });

    it('leaves optional fields undefined when missing', () => {
      const [t] = mapTickets([{ number: 1, title: 'T' }], github);
      assert.equal(t.status, undefined);
      assert.equal(t.url, undefined);
    });

    it('rejects an item without id or title, naming the item index', () => {
      assert.throws(() => mapTickets([{ number: 1, title: 'ok' }, { title: 'no id' }], github), /item 1.*id/);
      assert.throws(() => mapTickets([{ number: 1 }], github), /item 0.*title/);
    });

    it('rejects output that is not an array (after itemsPath)', () => {
      assert.throws(() => mapTickets({ issues: [] }, github), /array/);
      assert.throws(() => mapTickets([], jira), /array/);
    });

    it('accepts an empty list', () => {
      assert.deepEqual(mapTickets([], github), []);
    });
  });

  describe('fetchTickets', () => {
    it('runs the command and maps its JSON output', async () => {
      const tickets = await fetchTickets(github, fixtures);
      assert.deepEqual(tickets.map((t) => [t.id, t.title, t.status]), [
        ['42', 'Crash on empty config', 'OPEN'],
        ['7', 'Add dark mode', 'OPEN'],
      ]);
    });

    it('reports a failing command with its stderr', async () => {
      const cfg = { ...github, listCmd: `node "${path.join(fixtures, 'fail.js')}"` };
      await assert.rejects(fetchTickets(cfg, fixtures), /not logged in/);
    });

    it('reports output that is not JSON', async () => {
      const cfg = { ...github, listCmd: printFile('print-file.js') };
      await assert.rejects(fetchTickets(cfg, fixtures), /JSON/);
    });
  });

  describe('refreshSource + readSnapshot', () => {
    let dir: string;
    const t0 = new Date('2026-11-04T10:00:00Z');
    const t1 = new Date('2026-11-04T11:00:00Z');

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-snap-'));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('has no snapshot before the first refresh', () => {
      assert.equal(readSnapshot(dir, 'GitHub'), undefined);
    });

    it('stores tickets with fetchedAt and reads them back offline', async () => {
      await refreshSource(github, fixtures, dir, t0);
      const snap = readSnapshot(dir, 'GitHub');
      assert.equal(snap?.fetchedAt, t0.toISOString());
      assert.equal(snap?.tickets.length, 2);
      assert.equal(snap?.error, undefined);
    });

    it('keeps the previous tickets and fetchedAt when a refresh fails, and records the error', async () => {
      await refreshSource(github, fixtures, dir, t0);
      const broken = { ...github, listCmd: `node "${path.join(fixtures, 'fail.js')}"` };
      const snap = await refreshSource(broken, fixtures, dir, t1);

      assert.equal(snap.tickets.length, 2);
      assert.equal(snap.fetchedAt, t0.toISOString());
      assert.match(snap.error?.message ?? '', /not logged in/);
      assert.equal(snap.error?.at, t1.toISOString());
      assert.deepEqual(readSnapshot(dir, 'GitHub'), snap);
    });

    it('clears the error after a later successful refresh', async () => {
      const broken = { ...github, listCmd: `node "${path.join(fixtures, 'fail.js')}"` };
      await refreshSource(broken, fixtures, dir, t0);
      const snap = await refreshSource(github, fixtures, dir, t1);
      assert.equal(snap.error, undefined);
      assert.equal(snap.fetchedAt, t1.toISOString());
    });

    it('records an error with no tickets when the first refresh fails', async () => {
      const broken = { ...github, listCmd: `node "${path.join(fixtures, 'fail.js')}"` };
      const snap = await refreshSource(broken, fixtures, dir, t0);
      assert.deepEqual(snap.tickets, []);
      assert.equal(snap.fetchedAt, undefined);
      assert.ok(snap.error);
    });

    it('keeps sources with awkward names apart', async () => {
      await refreshSource({ ...github, name: 'a/b' }, fixtures, dir, t0);
      await refreshSource({ ...jira, name: 'a_b' }, fixtures, dir, t0);
      assert.equal(readSnapshot(dir, 'a/b')?.tickets[0].id, '42');
      assert.equal(readSnapshot(dir, 'a_b')?.tickets[0].id, 'PROJ-123');
    });

    it('treats a corrupt snapshot file as missing', () => {
      fs.writeFileSync(path.join(dir, `${encodeURIComponent('GitHub')}.json`), '{oops');
      assert.equal(readSnapshot(dir, 'GitHub'), undefined);
    });
  });

  describe('describeAge', () => {
    const now = new Date('2026-11-04T12:00:00Z');
    const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
    it('renders coarse, human ages', () => {
      assert.equal(describeAge(undefined, now), 'never fetched');
      assert.equal(describeAge(ago(30_000), now), 'just now');
      assert.equal(describeAge(ago(5 * 60_000), now), '5m ago');
      assert.equal(describeAge(ago(3 * 3_600_000), now), '3h ago');
      assert.equal(describeAge(ago(2 * 86_400_000), now), '2d ago');
    });
  });
});
