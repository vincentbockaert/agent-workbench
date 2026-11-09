import { strict as assert } from 'assert';
import { attentionOf, summarizeAttention } from '../../src/agents/status';

describe('your move', () => {
  describe('attentionOf (ticket row)', () => {
    it('needs input beats your move, which beats anything else', () => {
      assert.equal(attentionOf(['done', 'needs-input', 'working']), 'needs-input');
      assert.equal(attentionOf(['working', 'done', undefined]), 'done');
      assert.equal(attentionOf(['working', 'exited', undefined]), undefined);
      assert.equal(attentionOf([]), undefined);
    });
  });

  describe('summarizeAttention (status bar and view badge)', () => {
    it('is hidden when nothing waits for you', () => {
      const s = summarizeAttention(['working', 'exited', undefined]);
      assert.equal(s.count, 0);
      assert.equal(s.text, undefined);
    });

    it('counts needs input and your move separately in the text and together in the badge', () => {
      const s = summarizeAttention(['needs-input', 'done', 'done', 'working']);
      assert.equal(s.count, 3);
      assert.equal(s.text, '$(bell-dot) 1 · $(reply) 2');
      assert.equal(s.tooltip, '1 session needs your input\n2 sessions: your move (turn done)');
    });

    it('shows only the part that applies', () => {
      assert.equal(summarizeAttention(['done']).text, '$(reply) 1');
      assert.equal(summarizeAttention(['done']).tooltip, '1 session: your move (turn done)');
      assert.equal(summarizeAttention(['needs-input', 'needs-input']).text, '$(bell-dot) 2');
      assert.equal(summarizeAttention(['needs-input', 'needs-input']).tooltip, '2 sessions need your input');
    });
  });
});
