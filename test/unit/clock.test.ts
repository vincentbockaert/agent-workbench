import { strict as assert } from 'assert';
import { ClockTracker, SWITCH_DEBOUNCE_MS } from '../../src/time/clock';
import { TimeEventType } from '../../src/time/events';

const A = 'Jira:HDO-1';
const B = 'Jira:HDO-2';
const T0 = Date.parse('2026-11-05T09:00:00Z');

// A fake clock and scheduler: nothing real runs.
function setup() {
  let now = T0;
  const timers: { at: number; fn: () => void; id: number; live: boolean }[] = [];
  let ids = 0;
  const emitted: { type: TimeEventType; ticket: string; at: number }[] = [];
  let changes = 0;
  const clock = new ClockTracker(
    {
      now: () => now,
      emit: (type, ticket, at) => emitted.push({ type, ticket, at }),
      after: (ms, fn) => {
        const t = { at: now + ms, fn, id: ++ids, live: true };
        timers.push(t);
        return () => {
          t.live = false;
        };
      },
    },
    () => changes++,
  );
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const next = timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) {
        break;
      }
      now = next.at;
      next.live = false;
      next.fn();
    }
    now = end;
  };
  const types = () => emitted.map((e) => `${e.type}${e.ticket ? ` ${e.ticket}` : ''}`);
  return { clock, advance, emitted, types, changes: () => changes, now: () => now };
}

describe('ClockTracker', () => {
  it('puts a ticket on the clock and makes it active, once', () => {
    const t = setup();
    t.clock.start(A);
    t.clock.start(A);
    assert.deepEqual(t.types(), [`clock-on ${A}`]);
    assert.deepEqual(t.clock.state(), { onClock: [A], active: A });
  });

  it('starting a second ticket makes it active and pauses the first', () => {
    const t = setup();
    t.clock.start(A);
    t.clock.start(B);
    assert.deepEqual(t.clock.state(), { onClock: [A, B], active: B });
  });

  it('starting a paused ticket that is on the clock makes it active again', () => {
    const t = setup();
    t.clock.start(A);
    t.clock.start(B);
    t.clock.start(A);
    assert.deepEqual(t.types(), [`clock-on ${A}`, `clock-on ${B}`, `clock-on ${A}`]);
    assert.equal(t.clock.state().active, A);
  });

  describe('following your attention', () => {
    it('switches to another ticket on the clock only after sustained focus, backdated to when it began', () => {
      const t = setup();
      t.clock.start(A);
      t.clock.start(B);
      t.advance(5_000);
      t.clock.focus(A);
      t.advance(SWITCH_DEBOUNCE_MS - 1);
      assert.equal(t.clock.state().active, B, 'not yet');
      t.advance(1);
      assert.equal(t.clock.state().active, A);
      const attend = t.emitted.at(-1)!;
      assert.deepEqual([attend.type, attend.ticket, attend.at], ['attend', A, T0 + 5_000]);
    });

    it('does not switch on a short glance', () => {
      const t = setup();
      t.clock.start(A);
      t.clock.start(B);
      t.clock.focus(A);
      t.advance(4_000);
      t.clock.focus(B); // back on the active ticket
      t.advance(60_000);
      assert.equal(t.clock.state().active, B);
      assert.deepEqual(t.types(), [`clock-on ${A}`, `clock-on ${B}`]);
    });

    it('keeps the first start time while the same ticket keeps being focused', () => {
      const t = setup();
      t.clock.start(A);
      t.clock.start(B);
      t.clock.focus(A);
      t.advance(6_000);
      t.clock.focus(A); // another keystroke
      t.advance(SWITCH_DEBOUNCE_MS - 6_000);
      assert.equal(t.emitted.at(-1)!.at, T0);
    });

    it('stays on the active ticket when focus goes somewhere unrelated, but forgets a half-done switch', () => {
      const t = setup();
      t.clock.start(A);
      t.clock.start(B);
      t.clock.focus(A);
      t.advance(5_000);
      t.clock.focus(undefined);
      t.advance(60_000);
      assert.equal(t.clock.state().active, B);
      assert.deepEqual(t.types(), [`clock-on ${A}`, `clock-on ${B}`]);
    });

    it('ignores a ticket that is not on the clock', () => {
      const t = setup();
      t.clock.start(A);
      t.clock.focus(B);
      t.advance(60_000);
      assert.deepEqual(t.types(), [`clock-on ${A}`]);
    });

    it('does nothing for the already active ticket', () => {
      const t = setup();
      t.clock.start(A);
      t.clock.focus(A);
      t.advance(60_000);
      assert.deepEqual(t.types(), [`clock-on ${A}`]);
    });

    it('attends at once when nobody is active (no debounce needed)', () => {
      const t = setup();
      t.clock.start(A);
      t.clock.start(B);
      t.clock.stop(B); // B was active; A stays on the clock, paused
      t.advance(30_000);
      t.clock.focus(A);
      assert.equal(t.clock.state().active, A);
      assert.deepEqual([t.emitted.at(-1)!.type, t.emitted.at(-1)!.at], ['attend', T0 + 30_000]);
    });
  });

  describe('stopping', () => {
    it('stop takes a ticket off the clock; stopping the active one leaves nobody active', () => {
      const t = setup();
      t.clock.start(A);
      t.clock.start(B);
      t.clock.stop(B);
      assert.deepEqual(t.clock.state(), { onClock: [A], active: undefined });
      assert.equal(t.types().at(-1), `clock-off ${B}`);
    });

    it('stopping a paused ticket keeps the active one', () => {
      const t = setup();
      t.clock.start(A);
      t.clock.start(B);
      t.clock.stop(A);
      assert.deepEqual(t.clock.state(), { onClock: [B], active: B });
    });

    it('ignores stop for a ticket that is not on the clock', () => {
      const t = setup();
      t.clock.stop(A);
      assert.deepEqual(t.types(), []);
    });

    it('stopAll takes every ticket off the clock', () => {
      const t = setup();
      t.clock.start(A);
      t.clock.start(B);
      t.clock.stopAll();
      assert.deepEqual(t.types().slice(2), [`clock-off ${A}`, `clock-off ${B}`]);
      assert.deepEqual(t.clock.state(), { onClock: [], active: undefined });
    });

    it('stopAll can backdate (idle trim): every stop carries that time', () => {
      const t = setup();
      t.clock.start(A);
      t.advance(60_000);
      t.clock.stopAll(T0 + 20_000);
      assert.equal(t.emitted.at(-1)!.at, T0 + 20_000);
    });

    it('cancels a pending switch', () => {
      const t = setup();
      t.clock.start(A);
      t.clock.start(B);
      t.clock.focus(A);
      t.clock.stopAll();
      t.advance(60_000);
      assert.equal(t.types().filter((x) => x.startsWith('attend')).length, 0);
    });
  });

  describe('beats and reset', () => {
    it('beats only while a ticket is active', () => {
      const t = setup();
      t.clock.beat();
      assert.deepEqual(t.types(), []);
      t.clock.start(A);
      t.clock.beat();
      assert.equal(t.types().at(-1), 'clock-beat');
      t.clock.stop(A);
      t.clock.beat();
      assert.equal(t.types().filter((x) => x === 'clock-beat').length, 1);
    });

    it('reset logs clock-reset and forgets everything', () => {
      const t = setup();
      t.clock.start(A);
      t.clock.reset();
      assert.equal(t.types().at(-1), 'clock-reset');
      assert.deepEqual(t.clock.state(), { onClock: [], active: undefined });
    });
  });

  it('tells the UI whenever the state changes, and only then', () => {
    const t = setup();
    t.clock.start(A);
    t.clock.start(A);
    t.clock.stop(B);
    assert.equal(t.changes(), 1);
    t.clock.stop(A);
    assert.equal(t.changes(), 2);
  });
});

describe('clock events in the log', () => {
  it('are written and read back, including the global ones with an empty ticket', () => {
    const fs = require('fs') as typeof import('fs');
    const os = require('os') as typeof import('os');
    const path = require('path') as typeof import('path');
    const { appendEvent, readEvents } = require('../../src/time/log') as typeof import('../../src/time/log');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-clock-'));
    try {
      const types: TimeEventType[] = ['clock-on', 'attend', 'clock-beat', 'clock-off', 'clock-reset'];
      types.forEach((type, i) => appendEvent(dir, { ts: new Date(T0 + i * 1000).toISOString(), ticket: type === 'clock-beat' || type === 'clock-reset' ? '' : A, session: 'clock', type }));
      const { events, skipped } = readEvents(dir, { start: T0 - 1000, end: T0 + 60_000 });
      assert.equal(skipped, 0);
      assert.deepEqual(events.map((e) => e.type), types);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
