import { strict as assert } from 'assert';
import { adfToText } from '../../src/tickets/adf';

const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content });
const p = (...content: unknown[]) => ({ type: 'paragraph', content });
const t = (text: string, marks?: unknown[]) => ({ type: 'text', text, ...(marks ? { marks } : {}) });

describe('adfToText', () => {
  it('renders paragraphs separated by a blank line', () => {
    assert.equal(adfToText(doc(p(t('First.')), p(t('Second.')))), 'First.\n\nSecond.');
  });

  it('renders headings, rules and blockquotes', () => {
    const out = adfToText(
      doc({ type: 'heading', attrs: { level: 2 }, content: [t('Goal')] }, { type: 'rule' }, { type: 'blockquote', content: [p(t('quoted'))] }),
    );
    assert.equal(out, '## Goal\n\n---\n\n> quoted');
  });

  it('renders bullet and ordered lists, including nesting', () => {
    const li = (...c: unknown[]) => ({ type: 'listItem', content: c });
    const out = adfToText(
      doc(
        { type: 'bulletList', content: [li(p(t('a')), { type: 'bulletList', content: [li(p(t('a1')))] }), li(p(t('b')))] },
        { type: 'orderedList', content: [li(p(t('one'))), li(p(t('two')))] },
      ),
    );
    assert.equal(out, '- a\n  - a1\n- b\n\n1. one\n2. two');
  });

  it('renders inline marks: code, strong, emphasis and links', () => {
    const out = adfToText(
      doc(p(t('run '), t('npm test', [{ type: 'code' }]), t(' '), t('now', [{ type: 'strong' }]), t(' '), t('here', [{ type: 'em' }]), t(' '), t('docs', [{ type: 'link', attrs: { href: 'https://x.test/a' } }]))),
    );
    assert.equal(out, 'run `npm test` **now** _here_ [docs](https://x.test/a)');
  });

  it('renders code blocks with their language', () => {
    const out = adfToText(doc({ type: 'codeBlock', attrs: { language: 'yaml' }, content: [t('a: 1\nb: 2')] }));
    assert.equal(out, '```yaml\na: 1\nb: 2\n```');
  });

  it('renders hard breaks, mentions, inline cards and emoji', () => {
    const out = adfToText(
      doc(p(t('line1'), { type: 'hardBreak' }, t('line2 '), { type: 'mention', attrs: { id: 'x', text: '@Vincent' } }, t(' see '), { type: 'inlineCard', attrs: { url: 'https://x.test/b' } }, t(' '), { type: 'emoji', attrs: { shortName: ':tada:', text: '🎉' } })),
    );
    assert.equal(out, 'line1\nline2 @Vincent see https://x.test/b 🎉');
  });

  it('renders tables as pipe rows', () => {
    const cell = (s: string) => ({ type: 'tableCell', content: [p(t(s))] });
    const header = (s: string) => ({ type: 'tableHeader', content: [p(t(s))] });
    const out = adfToText(
      doc({ type: 'table', content: [{ type: 'tableRow', content: [header('Env'), header('State')] }, { type: 'tableRow', content: [cell('uat'), cell('up')] }] }),
    );
    assert.equal(out, '| Env | State |\n| --- | --- |\n| uat | up |');
  });

  it('marks attachments instead of dropping them silently', () => {
    const out = adfToText(doc({ type: 'mediaSingle', content: [{ type: 'media', attrs: { type: 'file', id: 'abc', alt: 'diagram.png' } }] }));
    assert.equal(out, '[attachment: diagram.png]');
  });

  it('keeps the text of nodes it does not know', () => {
    assert.equal(adfToText(doc({ type: 'panel', attrs: { panelType: 'info' }, content: [p(t('Heads up'))] })), 'Heads up');
    assert.equal(adfToText(doc({ type: 'somethingNew', content: [p(t('still here'))] })), 'still here');
  });

  it('returns undefined for anything that is not a document, and for an empty one', () => {
    assert.equal(adfToText(undefined), undefined);
    assert.equal(adfToText('plain'), undefined);
    assert.equal(adfToText({ foo: 1 }), undefined);
    assert.equal(adfToText(doc()), undefined);
    assert.equal(adfToText(doc(p())), undefined);
  });

  it('does not throw on malformed content', () => {
    assert.doesNotThrow(() => adfToText({ type: 'doc', content: [null, 7, { type: 'paragraph', content: 'oops' }, { type: 'text' }] }));
  });
});
