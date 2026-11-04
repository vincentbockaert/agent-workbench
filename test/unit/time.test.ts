import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { roundUpMs, totalsByTicket } from '../../src/time/compute';
import { TimeEvent, TimeEventType } from '../../src/time/events';
import { appendEvent, readEvents } from '../../src/time/log';

const MIN = 60_000;
const BASE = Date.parse('2026-11-04T09:00:00Z');
// Day ranges are passed in explicitly, so these tests do not depend on the machine's time zone.
const DAY = { start: Date.parse('2026-11-04T00:00:00Z'), end: Date.parse('2026-11-05T00:00:00Z') };
const OPTS = { idleMs: 5 * MIN };

function ev(minute: number, type: TimeEventType, session = 's1', ticket = 'GitHub:42', extra: Partial<TimeEvent> = {}): TimeEvent {
  return { ts: new Date(BASE + minute * MIN).toISOString(), ticket, session, type, ...extra };
}

function minutes(events: TimeEvent[], ticket = 'GitHub:42', range = DAY) {
  const t = totalsByTicket(events, range, OPTS)[ticket];
  return t && { your: t.yourMs / MIN, agent: t.agentMs / MIN, elapsed: t.elapsedMs / MIN };
}

describe('time', () => {
  describe('agent time', () => {
    it('counts from agent-working to agent-idle', () => {
      assert.deepEqual(minutes([ev(0, 'agent-working'), ev(20, 'agent-idle')]), { your: 0, agent: 20, elapsed: 20 });
    });

    it('counts overlapping sessions on the same ticket once (union)', () => {
      const events = [ev(0, 'agent-working', 's1'), ev(10, 'agent-working', 's2'), ev(20, 'agent-idle', 's1'), ev(30, 'agent-idle', 's2')];
      assert.equal(minutes(events)?.agent, 30);
    });

    it('keeps tickets independent', () => {
      const events = [ev(0, 'agent-working', 's1', 'GitHub:42'), ev(10, 'agent-working', 's2', 'Jira:P-1'), ev(20, 'agent-idle', 's1', 'GitHub:42'), ev(40, 'agent-idle', 's2', 'Jira:P-1')];
      assert.equal(minutes(events, 'GitHub:42')?.agent, 20);
      assert.equal(minutes(events, 'Jira:P-1')?.agent, 30);
    });

    it('ignores a repeated agent-working while already working', () => {
      assert.equal(minutes([ev(0, 'agent-working'), ev(5, 'agent-working'), ev(20, 'agent-idle')])?.agent, 20);
    });

    it('closes an interval left open (e.g. after a crash) at the session\'s last recorded event, never "now"', () => {
      assert.equal(minutes([ev(0, 'agent-working'), ev(12, 'activity')])?.agent, 12);
      assert.equal(minutes([ev(0, 'agent-working')]), undefined, 'zero time: ticket omitted');
    });

    it('closes open intervals at session-end', () => {
      assert.equal(minutes([ev(0, 'agent-working'), ev(25, 'session-end')])?.agent, 25);
    });
  });

  describe('your time (focus + heartbeats)', () => {
    it('counts from focus-start to focus-end when activity keeps the gaps within the idle limit', () => {
      const events = [ev(0, 'focus-start'), ev(4, 'activity'), ev(8, 'activity'), ev(10, 'focus-end')];
      assert.equal(minutes(events)?.your, 10);
    });

    it('stops at the last heartbeat when the gap to the next one exceeds the idle limit, then resumes', () => {
      // 0–4 counted, 4→20 idle gap (16 > 5) not counted, 20–22 counted.
      const events = [ev(0, 'focus-start'), ev(4, 'activity'), ev(20, 'activity'), ev(22, 'focus-end')];
      assert.equal(minutes(events)?.your, 6);
    });

    it('ends at the last heartbeat when focus-end comes long after it', () => {
      assert.equal(minutes([ev(0, 'focus-start'), ev(3, 'activity'), ev(60, 'focus-end')])?.your, 3);
    });

    it('counts nothing for activity without focus', () => {
      assert.equal(minutes([ev(0, 'activity'), ev(3, 'activity')])?.your ?? 0, 0);
    });

    it('closes an unterminated focus interval at the last heartbeat', () => {
      assert.equal(minutes([ev(0, 'focus-start'), ev(2, 'activity'), ev(4, 'activity')])?.your, 4);
    });

    it('counts focus on two sessions of the same ticket once', () => {
      const events = [ev(0, 'focus-start', 's1'), ev(2, 'focus-start', 's2'), ev(4, 'focus-end', 's1'), ev(6, 'focus-end', 's2')];
      assert.equal(minutes(events)?.your, 6);
    });
  });

  describe('elapsed', () => {
    it('is the union of your time and agent time', () => {
      // agent 0–20, you 15–30 → elapsed 0–30
      const events = [ev(0, 'agent-working'), ev(15, 'focus-start'), ev(20, 'agent-idle'), ev(19, 'activity'), ev(23, 'activity'), ev(27, 'activity'), ev(30, 'focus-end')];
      assert.deepEqual(minutes(events), { your: 15, agent: 20, elapsed: 30 });
    });
  });

  describe('adjust', () => {
    it('adds to your time and elapsed, not agent time', () => {
      const events = [ev(0, 'agent-working'), ev(10, 'agent-idle'), ev(11, 'adjust', 's1', 'GitHub:42', { minutes: 30, note: 'call' })];
      assert.deepEqual(minutes(events), { your: 30, agent: 10, elapsed: 40 });
    });

    it('subtracts with negative minutes but never goes below zero', () => {
      // your 8 - 25 → 0 (not -17); elapsed 20 - 25 → 0; agent time is untouched by adjustments.
      const events = [ev(0, 'agent-working'), ev(0, 'focus-start'), ev(4, 'activity'), ev(8, 'focus-end'), ev(20, 'agent-idle'), ev(21, 'adjust', 's1', 'GitHub:42', { minutes: -25 })];
      assert.deepEqual(minutes(events), { your: 0, agent: 20, elapsed: 0 });
      const partial = [ev(0, 'focus-start'), ev(4, 'activity'), ev(8, 'activity'), ev(10, 'focus-end'), ev(11, 'adjust', 's1', 'GitHub:42', { minutes: -4 })];
      assert.deepEqual(minutes(partial), { your: 6, agent: 0, elapsed: 6 });
    });

    it('counts on the day the adjustment is dated', () => {
      const nextDay = { start: DAY.end, end: DAY.end + 24 * 60 * MIN };
      const events = [ev(0, 'adjust', 's1', 'GitHub:42', { minutes: 15 })];
      assert.equal(minutes(events, 'GitHub:42', nextDay), undefined);
    });
  });

  describe('ranges', () => {
    it('splits an interval at the range boundary (e.g. local midnight)', () => {
      const lateEvening = Date.parse('2026-11-04T23:00:00Z');
      const at = (m: number, type: TimeEventType): TimeEvent => ({ ts: new Date(lateEvening + m * MIN).toISOString(), ticket: 'T:1', session: 's', type });
      const events = [at(0, 'agent-working'), at(120, 'agent-idle')];
      const nextDay = { start: DAY.end, end: DAY.end + 24 * 60 * MIN };
      assert.equal(minutes(events, 'T:1', DAY)?.agent, 60);
      assert.equal(minutes(events, 'T:1', nextDay)?.agent, 60);
    });

    it('omits tickets with no time in the range', () => {
      const nextDay = { start: DAY.end, end: DAY.end + 24 * 60 * MIN };
      assert.deepEqual(totalsByTicket([ev(0, 'agent-working'), ev(10, 'agent-idle')], nextDay, OPTS), {});
    });

    it('does not depend on input order', () => {
      const events = [ev(0, 'agent-working'), ev(20, 'agent-idle'), ev(5, 'focus-start'), ev(9, 'focus-end')];
      const shuffled = [events[3], events[1], events[0], events[2]];
      assert.deepEqual(totalsByTicket(shuffled, DAY, OPTS), totalsByTicket(events, DAY, OPTS));
    });
  });

  describe('roundUpMs', () => {
    it('rounds up to whole blocks and leaves zero and exact blocks alone', () => {
      assert.equal(roundUpMs(0, 15), 0);
      assert.equal(roundUpMs(1, 15), 15 * MIN);
      assert.equal(roundUpMs(15 * MIN, 15), 15 * MIN);
      assert.equal(roundUpMs(16 * MIN, 15), 30 * MIN);
    });

    it('returns the exact value when rounding is off (0 minutes)', () => {
      assert.equal(roundUpMs(16 * MIN + 1, 0), 16 * MIN + 1);
    });
  });

  describe('log file', () => {
    let dir: string;
    beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-time-'))));
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    const at = (iso: string, type: TimeEventType = 'activity'): TimeEvent => ({ ts: iso, ticket: 'T:1', session: 's', type });

    it('appends one JSON line per event into a monthly file, creating the folder', () => {
      const logDir = path.join(dir, 'timelog');
      appendEvent(logDir, at('2026-11-04T10:00:00.000Z'));
      appendEvent(logDir, at('2026-11-04T10:01:00.000Z'));
      assert.deepEqual(fs.readdirSync(logDir), ['2026-11.jsonl']);
      assert.equal(fs.readFileSync(path.join(logDir, '2026-11.jsonl'), 'utf8').trim().split('\n').length, 2);
    });

    it('reads events back sorted, including the previous month for intervals that started earlier', () => {
      appendEvent(dir, at('2026-11-01T00:30:00.000Z', 'agent-idle'));
      appendEvent(dir, at('2026-10-31T23:30:00.000Z', 'agent-working'));
      const { events, skipped } = readEvents(dir, { start: Date.parse('2026-11-01T00:00:00Z'), end: Date.parse('2026-11-02T00:00:00Z') });
      assert.deepEqual(events.map((e) => e.type), ['agent-working', 'agent-idle']);
      assert.equal(skipped, 0);
    });

    it('skips unreadable lines and reports how many', () => {
      appendEvent(dir, at('2026-11-04T10:00:00.000Z'));
      fs.appendFileSync(path.join(dir, '2026-11.jsonl'), '{broken\n{"ts":"x"}\n');
      const { events, skipped } = readEvents(dir, DAY);
      assert.equal(events.length, 1);
      assert.equal(skipped, 2);
    });

    it('returns nothing for an empty or missing folder', () => {
      assert.deepEqual(readEvents(path.join(dir, 'missing'), DAY), { events: [], skipped: 0 });
    });
  });
});
