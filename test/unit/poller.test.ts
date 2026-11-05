import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StatusPoller } from '../../src/agents/poller';

describe('StatusPoller', () => {
  let dir: string;
  let clock: number;
  let changed: string[];
  const file = (name: string) => path.join(dir, name);
  // Distinct mtimes without sleeping: the poller compares inode, mtime and size.
  const write = (name: string, content: string, mtimeSec: number) => {
    fs.writeFileSync(file(name), content);
    fs.utimesSync(file(name), mtimeSec, mtimeSec);
  };
  const make = (cold: (id: string) => boolean = () => false, coldEvery = 3) =>
    new StatusPoller((id) => changed.push(id), cold, coldEvery, () => clock);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-poll-'));
    changed = [];
    clock = 1_000_000;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reports nothing for a file that has not changed since it was added', async () => {
    write('a', '{"state":"done"}', 1000);
    const p = make();
    p.add('a', file('a'));
    await p.tick();
    await p.tick();
    assert.deepEqual(changed, []);
  });

  it('reports a file that was rewritten, once', async () => {
    write('a', '{"state":"done"}', 1000);
    const p = make();
    p.add('a', file('a'));
    write('a', '{"state":"working"}', 2000);
    await p.tick();
    await p.tick();
    assert.deepEqual(changed, ['a']);
  });

  it('reports a file that appears or disappears', async () => {
    const p = make();
    p.add('a', file('a'));
    write('a', '{}', 1000);
    await p.tick();
    fs.rmSync(file('a'));
    await p.tick();
    assert.deepEqual(changed, ['a', 'a']);
  });

  it('does not report again a change that was already handled via note()', async () => {
    write('a', 'one', 1000);
    const p = make();
    p.add('a', file('a'));
    write('a', 'two!', 2000);
    p.note('a'); // e.g. the file watcher handled it
    await p.tick();
    assert.deepEqual(changed, []);
  });

  it('checks cold sessions only every coldEvery-th tick, hot ones every tick', async () => {
    write('hot', 'x', 1000);
    write('cold', 'x', 1000);
    const p = make((id) => id === 'cold', 3);
    p.add('hot', file('hot'));
    p.add('cold', file('cold'));
    write('hot', 'xx', 2000);
    write('cold', 'xx', 2000);
    await p.tick(); // 1
    assert.deepEqual(changed, ['hot']);
    await p.tick(); // 2
    assert.deepEqual(changed, ['hot']);
    await p.tick(); // 3
    assert.deepEqual(changed, ['hot', 'cold']);
  });

  it('checks a heated cold session on every tick until the heat runs out', async () => {
    write('c', 'x', 1000);
    const p = make(() => true, 100);
    p.add('c', file('c'));
    p.heat('c', 60_000);
    write('c', 'xx', 2000);
    await p.tick();
    assert.deepEqual(changed, ['c']);
    clock += 61_000;
    write('c', 'xxx', 3000);
    await p.tick();
    await p.tick();
    assert.deepEqual(changed, ['c'], 'cold again after the heat expired');
  });

  it('ignores a tick that starts while the previous one is still running', async () => {
    write('a', 'x', 1000);
    const p = make();
    p.add('a', file('a'));
    write('a', 'xx', 2000);
    await Promise.all([p.tick(), p.tick(), p.tick()]);
    assert.deepEqual(changed, ['a']);
  });

  it('forgets removed sessions', async () => {
    write('a', 'x', 1000);
    const p = make();
    p.add('a', file('a'));
    p.remove('a');
    write('a', 'xx', 2000);
    await p.tick();
    assert.deepEqual(changed, []);
  });

  it('keeps going when one session\'s folder is gone', async () => {
    write('b', 'x', 1000);
    const p = make();
    p.add('gone', path.join(dir, 'no', 'such', 'dir', 'status.json'));
    p.add('b', file('b'));
    write('b', 'xx', 2000);
    await p.tick();
    assert.deepEqual(changed, ['b']);
  });
});
