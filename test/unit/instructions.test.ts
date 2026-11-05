import { strict as assert } from 'assert';
import { extractInstructions, instructionsTemplate } from '../../src/sessions/instructions';

describe('instructions', () => {
  it('is empty when the template is left untouched', () => {
    assert.equal(extractInstructions(instructionsTemplate('HDO-1 Fix it')), '');
  });

  it('returns what was written below the hint, trimmed', () => {
    assert.equal(extractInstructions(`${instructionsTemplate('HDO-1')}\n  Do A.\n\nThen B.  \n\n`), 'Do A.\n\nThen B.');
  });

  it('keeps text when the user deleted the hint', () => {
    assert.equal(extractInstructions('Just do it'), 'Just do it');
  });

  it('keeps HTML comments the user wrote after the hint', () => {
    assert.equal(extractInstructions(`${instructionsTemplate('X')}Use <!-- not a hint --> carefully`), 'Use <!-- not a hint --> carefully');
  });

  it('mentions the ticket and how to start or skip, and cannot be broken by a title containing -->', () => {
    const t = instructionsTemplate('HDO-9 a --> b');
    assert.match(t, /HDO-9/);
    assert.match(t, /Start Agent/);
    assert.equal(extractInstructions(t), '');
  });
});
