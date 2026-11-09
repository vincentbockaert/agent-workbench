import { strict as assert } from 'assert';
import manifest from '../../package.json';
import { ticketContextValue } from '../../src/ui/group';

// Evaluates the `viewItem` parts of a when-clause (all are joined with &&) against a context value.
function shows(command: string, group: string, viewItem: string): boolean {
  const entries = (manifest.contributes.menus['view/item/context'] as { command: string; when: string; group: string }[]).filter(
    (m) => m.command === command && m.group.startsWith(group),
  );
  assert.ok(entries.length > 0, `no ${group} menu entry for ${command}`);
  return entries.some((m) =>
    m.when.split('&&').every((part) => {
      const p = part.trim();
      const re = /^viewItem =~ \/(.*)\/$/.exec(p);
      if (re) {
        return new RegExp(re[1]).test(viewItem);
      }
      const eq = /^viewItem == (\S+)$/.exec(p);
      return eq ? eq[1] === viewItem : true;
    }),
  );
}

describe('tree clock buttons', () => {
  const all = [true, false].flatMap((listed) => [true, false].flatMap((url) => [true, false].map((onClock) => ({ listed, url, onClock }))));

  it('names a ticket row by listing, url and clock', () => {
    assert.equal(ticketContextValue({ listed: true, url: false, onClock: false }), 'ticket');
    assert.equal(ticketContextValue({ listed: false, url: true, onClock: true }), 'ticketUnlistedWithUrlOnClock');
    assert.equal(ticketContextValue({ listed: true, url: true, onClock: true }), 'ticketWithUrlOnClock');
  });

  it('shows an inline Stop Timer on tickets on the clock and an inline Start Timer on the others', () => {
    for (const t of all) {
      const v = ticketContextValue(t);
      assert.equal(shows('agentWorkbench.stopTimer', 'inline', v), t.onClock, `stop on ${v}`);
      assert.equal(shows('agentWorkbench.startTimer', 'inline', v), !t.onClock, `start on ${v}`);
    }
  });

  it('keeps the existing ticket buttons whether or not the ticket is on the clock', () => {
    for (const t of all) {
      const v = ticketContextValue(t);
      assert.equal(shows('agentWorkbench.newSessionForTicket', 'inline', v), t.listed, `new session on ${v}`);
      assert.equal(shows('agentWorkbench.openTicketInBrowser', 'inline', v), t.url, `browser on ${v}`);
      assert.ok(shows('agentWorkbench.openTicketHub', '1_open', v));
      assert.ok(shows('agentWorkbench.startTimer', '5_time', v));
    }
  });
});
