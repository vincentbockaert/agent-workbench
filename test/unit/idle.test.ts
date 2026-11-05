import { strict as assert } from 'assert';
import { autoStopTime, shouldAskIdle } from '../../src/time/idle';

const MIN = 60_000;
const base = { now: 1_000 * MIN, lastActivity: 1_000 * MIN - 20 * MIN, thresholdMs: 15 * MIN, clockActive: true, agentWorking: false, promptOpen: false, lastAskedAt: undefined as number | undefined };

describe('shouldAskIdle', () => {
  it('asks when a ticket accrues time and nothing happened for the threshold', () => {
    assert.equal(shouldAskIdle(base), true);
  });
  it('does not ask before the threshold', () => {
    assert.equal(shouldAskIdle({ ...base, lastActivity: base.now - 14 * MIN }), false);
  });
  it('does not ask when no ticket is active', () => {
    assert.equal(shouldAskIdle({ ...base, clockActive: false }), false);
  });
  it('does not ask while the agent works on the active ticket', () => {
    assert.equal(shouldAskIdle({ ...base, agentWorking: true }), false);
  });
  it('does not ask while a question is open', () => {
    assert.equal(shouldAskIdle({ ...base, promptOpen: true }), false);
  });
  it('is off when the threshold is 0', () => {
    assert.equal(shouldAskIdle({ ...base, thresholdMs: 0 }), false);
  });
  it('does not ask again right after a dismissed question, but after another threshold', () => {
    assert.equal(shouldAskIdle({ ...base, lastAskedAt: base.now - 5 * MIN }), false);
    assert.equal(shouldAskIdle({ ...base, lastAskedAt: base.now - 15 * MIN }), true);
  });
  it('asks again when there was activity after the last question and a new idle period has passed', () => {
    assert.equal(shouldAskIdle({ ...base, lastAskedAt: base.now - 18 * MIN, lastActivity: base.now - 16 * MIN }), true);
  });
});

describe('autoStopTime', () => {
  const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m).getTime();

  it('returns the configured time when it was crossed between two checks', () => {
    assert.equal(autoStopTime(at(5, 18, 59), at(5, 19, 1), '19:00'), at(5, 19, 0));
  });
  it('returns nothing when the time was not crossed', () => {
    assert.equal(autoStopTime(at(5, 17, 0), at(5, 18, 59), '19:00'), undefined);
    assert.equal(autoStopTime(at(5, 19, 1), at(5, 19, 5), '19:00'), undefined);
  });
  it('counts reaching the time exactly, but not having been there already', () => {
    assert.equal(autoStopTime(at(5, 18, 59), at(5, 19, 0), '19:00'), at(5, 19, 0));
    assert.equal(autoStopTime(at(5, 19, 0), at(5, 19, 1), '19:00'), undefined);
  });
  it('returns the most recent crossing after a long sleep over several evenings', () => {
    assert.equal(autoStopTime(at(5, 18, 0), at(8, 9, 0), '19:00'), at(7, 19, 0));
  });
  it('accepts one-digit hours and rejects nonsense or an empty value (disabled)', () => {
    assert.equal(autoStopTime(at(5, 8, 0), at(5, 18, 0), '9:30'), at(5, 9, 30));
    for (const bad of ['', 'abc', '25:00', '12:60', '19']) {
      assert.equal(autoStopTime(at(5, 0, 0), at(5, 23, 0), bad), undefined, bad);
    }
  });
});
