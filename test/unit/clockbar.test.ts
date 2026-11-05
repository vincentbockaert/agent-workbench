import { strict as assert } from 'assert';
import { renderClockBar, shortLabel } from '../../src/time/clockbar';

const MIN = 60_000;
const A = 'Jira HDO:HDO-2064';
const B = 'Jira HDO:HDO-2071';
const times: Record<string, number> = { [A]: 72 * MIN, [B]: 25 * MIN };
const label = (k: string) => shortLabel(k, {});

describe('clock bar', () => {
  it('says the timer is off when nothing is on the clock', () => {
    const bar = renderClockBar({ onClock: [], active: undefined }, () => 0, label, {});
    assert.equal(bar.text, '$(watch) Timer off');
    assert.match(bar.tooltip, /Click to start/);
  });

  it('shows the active ticket as running and the others as paused, each with its time today', () => {
    const bar = renderClockBar({ onClock: [A, B], active: A }, (k) => times[k], label, {});
    assert.equal(bar.text, '$(play) HDO-2064 1h 12m · $(debug-pause) HDO-2071 25m');
  });

  it('shows a ticket on the clock that nobody is attending to as paused', () => {
    const bar = renderClockBar({ onClock: [B], active: undefined }, (k) => times[k], label, {});
    assert.equal(bar.text, '$(debug-pause) HDO-2071 25m');
  });

  it('lists titles in the tooltip', () => {
    const bar = renderClockBar({ onClock: [A], active: A }, (k) => times[k], label, { [A]: 'Connective redirect' });
    assert.match(bar.tooltip, /HDO-2064: Connective redirect/);
  });

  it('labels a ticket by its id and an ad-hoc session by its title', () => {
    assert.equal(shortLabel('GitHub:42', {}), '42');
    assert.equal(shortLabel('adhoc:spike-1', { 'adhoc:spike-1': 'Try the parser' }), 'Try the parser');
    assert.equal(shortLabel('adhoc:spike-1', {}), 'spike-1');
  });
});
