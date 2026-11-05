import { strict as assert } from 'assert';
import { ticketIntervals, totalsByTicket } from '../../src/time/compute';
import { TimeEvent, TimeEventType } from '../../src/time/events';

const MIN = 60_000;
const BASE = Date.parse('2026-11-05T09:00:00Z');
const DAY = { start: Date.parse('2026-11-05T00:00:00Z'), end: Date.parse('2026-11-06T00:00:00Z') };
const OPTS = { idleMs: 5 * MIN };
const A = 'Jira:HDO-1';
const B = 'Jira:HDO-2';

// Clock events are ticket-level; `session` only has to be a string.
function ev(minute: number, type: TimeEventType, ticket = A, extra: Partial<TimeEvent> = {}): TimeEvent {
  return { ts: new Date(BASE + minute * MIN).toISOString(), ticket, session: `s-${ticket}`, type, ...extra };
}
const beat = (minute: number) => ev(minute, 'clock-beat', '');
const reset = (minute: number) => ev(minute, 'clock-reset', '');

function timer(events: TimeEvent[], range = DAY, opts: { asOf?: number } = {}): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [ticket, t] of Object.entries(totalsByTicket(events, range, { ...OPTS, ...opts }))) {
    out[ticket] = t.timerMs / MIN;
  }
  return out;
}

describe('timer', () => {
  describe('on the clock, one active', () => {
    it('counts a ticket from clock-on to clock-off', () => {
      assert.deepEqual(timer([ev(0, 'clock-on'), ev(30, 'clock-off')]), { [A]: 30 });
    });

    it('moves the time with your attention: A, then B, then back to A', () => {
      const events = [ev(0, 'clock-on', A), ev(10, 'clock-on', B), ev(25, 'attend', A), ev(40, 'clock-off', A), ev(40, 'clock-off', B)];
      // A: 0-10 and 25-40; B: 10-25. Never counted twice.
      assert.deepEqual(timer(events), { [A]: 25, [B]: 15 });
    });

    it('pauses (does not stop) the ticket you leave: it resumes on attend', () => {
      const events = [ev(0, 'clock-on', A), ev(10, 'clock-on', B), ev(20, 'attend', A), ev(30, 'attend', B), ev(35, 'clock-off', B), ev(35, 'clock-off', A)];
      assert.deepEqual(timer(events), { [A]: 10 + 10, [B]: 10 + 5 });
    });

    it('ignores attend for a ticket that is not on the clock', () => {
      assert.deepEqual(timer([ev(0, 'clock-on', A), ev(10, 'attend', B), ev(30, 'clock-off', A)]), { [A]: 30 });
    });

    it('does nothing for attend of the ticket that is already active', () => {
      assert.deepEqual(timer([ev(0, 'clock-on'), ev(10, 'attend'), ev(20, 'clock-off')]), { [A]: 20 });
    });

    it('stopping the active ticket pauses everyone until the next attend', () => {
      const events = [ev(0, 'clock-on', A), ev(5, 'clock-on', B), ev(15, 'clock-off', B), ev(30, 'attend', A), ev(40, 'clock-off', A)];
      // B active 5-15. Then nobody is active 15-30. A active 30-40, plus its first 0-5.
      assert.deepEqual(timer(events), { [A]: 15, [B]: 10 });
    });

    it('turning the clock on again for an active ticket changes nothing', () => {
      assert.deepEqual(timer([ev(0, 'clock-on'), ev(10, 'clock-on'), ev(20, 'clock-off')]), { [A]: 20 });
    });

    it('ignores clock-off for a ticket that is not on the clock', () => {
      assert.deepEqual(timer([ev(0, 'clock-on', A), ev(10, 'clock-off', B), ev(20, 'clock-off', A)]), { [A]: 20 });
    });
  });

  describe('safety: never counts time nobody recorded', () => {
    it('closes an open interval at the last recorded event, not at now', () => {
      assert.deepEqual(timer([ev(0, 'clock-on'), ev(12, 'agent-working')]), { [A]: 12 });
    });

    it('lets beats keep an interval alive', () => {
      assert.deepEqual(timer([ev(0, 'clock-on'), beat(1), beat(2), beat(3)]), { [A]: 3 });
    });

    it('closes an open interval at asOf when asked for a live view', () => {
      assert.deepEqual(timer([ev(0, 'clock-on'), beat(3)], DAY, { asOf: BASE + 10 * MIN }), { [A]: 10 });
    });

    it('does not let asOf shorten an interval below the last event', () => {
      assert.deepEqual(timer([ev(0, 'clock-on'), beat(8)], DAY, { asOf: BASE + 5 * MIN }), { [A]: 8 });
    });

    it('a reset closes the active interval at the last event before it and clears the clock', () => {
      const events = [ev(0, 'clock-on', A), ev(5, 'clock-on', B), beat(8), reset(120), ev(130, 'attend', A), ev(140, 'clock-off', A)];
      // B active 5-8 (last event before the reset). Attend after the reset is ignored: A is off the clock.
      assert.deepEqual(timer(events), { [A]: 5, [B]: 3 });
    });

    it('a ticket can be put on the clock again after a reset', () => {
      assert.deepEqual(timer([ev(0, 'clock-on'), beat(10), reset(60), ev(70, 'clock-on'), ev(80, 'clock-off')]), { [A]: 20 });
    });

    it('splits an interval that spans midnight between the two days', () => {
      const late = { ts: '2026-11-05T23:50:00Z', ticket: A, session: 's', type: 'clock-on' as const };
      const end = { ts: '2026-11-06T00:20:00Z', ticket: A, session: 's', type: 'clock-off' as const };
      const day2 = { start: DAY.end, end: DAY.end + 24 * 60 * MIN };
      assert.deepEqual(timer([late, end], DAY), { [A]: 10 });
      assert.deepEqual(timer([late, end], day2), { [A]: 20 });
    });
  });

  describe('corrections and old days', () => {
    it('counts adjustments dated in the range', () => {
      assert.deepEqual(timer([ev(0, 'clock-on'), ev(10, 'clock-off'), ev(60, 'adjust', A, { minutes: 20 })]), { [A]: 30 });
      assert.deepEqual(timer([ev(0, 'clock-on'), ev(10, 'clock-off'), ev(60, 'adjust', A, { minutes: -4 })]), { [A]: 6 });
    });

    it('shows a ticket that only has an adjustment', () => {
      assert.deepEqual(timer([ev(60, 'adjust', B, { minutes: 15 })]), { [B]: 15 });
    });

    it('uses the clock only for days that have clock events; other days book elapsed as before', () => {
      const legacy = [ev(0, 'agent-working', A), ev(20, 'agent-idle', A)];
      assert.deepEqual(timer(legacy), { [A]: 20 });
      const withClock = [...legacy, ev(30, 'clock-on', B), ev(40, 'clock-off', B)];
      // A has agent time but was never on the clock: it books nothing on a day that used the clock.
      assert.deepEqual(timer(withClock), { [A]: 0, [B]: 10 });
    });

    it('is not fooled by a clock interval from the day before when the range has no clock events of its own', () => {
      const e = [ev(-24 * 60 + 10, 'clock-on'), ev(-24 * 60 + 30, 'clock-off'), ev(0, 'agent-working', B), ev(20, 'agent-idle', B)];
      assert.deepEqual(timer(e), { [B]: 20 });
    });

    it('applies a backdated clock-off (idle trim) even when later beats were already logged', () => {
      // Last activity at minute 20; the prompt at minute 40 stops the clock "at 20". Beats at 21..40 were logged meanwhile.
      const events = [ev(0, 'clock-on'), beat(21), beat(30), beat(40), ev(20, 'clock-off', A)];
      assert.deepEqual(timer(events), { [A]: 20 });
    });

    it('does not depend on the order lines were written in', () => {
      const events = [ev(10, 'clock-off', A), ev(0, 'clock-on', A)];
      assert.deepEqual(timer(events), { [A]: 10 });
    });
  });

  describe('timeline intervals', () => {
    it('exposes the merged timer intervals per ticket', () => {
      const events = [ev(0, 'clock-on', A), ev(10, 'clock-on', B), ev(25, 'attend', A), ev(40, 'clock-off', A), ev(40, 'clock-off', B)];
      const ivs = ticketIntervals(events, DAY, OPTS);
      assert.deepEqual(ivs[A].timer, [[BASE, BASE + 10 * MIN], [BASE + 25 * MIN, BASE + 40 * MIN]]);
      assert.deepEqual(ivs[B].timer, [[BASE + 10 * MIN, BASE + 25 * MIN]]);
    });
  });
});
