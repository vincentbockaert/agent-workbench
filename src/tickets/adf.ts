// Atlassian Document Format (what Jira and the Atlassian CLIs return for rich-text fields) to Markdown-ish text.
// Pure, no vscode import. Unknown nodes degrade to their text content; nothing throws.

interface AdfNode {
  type?: unknown;
  text?: unknown;
  content?: unknown;
  attrs?: Record<string, unknown>;
  marks?: unknown;
}

const isNode = (v: unknown): v is AdfNode => typeof v === 'object' && v !== null && !Array.isArray(v);
const kids = (n: AdfNode): AdfNode[] => (Array.isArray(n.content) ? n.content.filter(isNode) : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

// undefined when `doc` is not an ADF document or has no text in it.
export function adfToText(doc: unknown): string | undefined {
  if (!isNode(doc) || doc.type !== 'doc') {
    return undefined;
  }
  const out = blocks(kids(doc)).trim();
  return out === '' ? undefined : out;
}

function blocks(nodes: AdfNode[]): string {
  return nodes.map(block).filter((s) => s !== '').join('\n\n');
}

function block(n: AdfNode): string {
  switch (n.type) {
    case 'paragraph':
      return inline(kids(n));
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(n.attrs?.level) || 1));
      return `${'#'.repeat(level)} ${inline(kids(n))}`;
    }
    case 'rule':
      return '---';
    case 'blockquote':
      return blocks(kids(n))
        .split('\n')
        .map((l) => (l ? `> ${l}` : '>'))
        .join('\n');
    case 'bulletList':
    case 'orderedList':
      return list(n);
    case 'codeBlock':
      return `\`\`\`${str(n.attrs?.language) ?? ''}\n${kids(n).map((k) => str(k.text) ?? '').join('')}\n\`\`\``;
    case 'table':
      return table(n);
    case 'mediaSingle':
    case 'mediaGroup':
      return kids(n).map(attachment).join('\n');
    case 'media':
      return attachment(n);
    case 'text':
    case 'hardBreak':
    case 'mention':
    case 'inlineCard':
    case 'emoji':
    case 'status':
    case 'date':
      return inline([n]);
    default:
      return blocks(kids(n)); // panels, expands, layouts and node types added later: keep their text
  }
}

function list(n: AdfNode): string {
  const ordered = n.type === 'orderedList';
  return kids(n)
    .filter((item) => item.type === 'listItem')
    .map((item, i) => {
      const marker = ordered ? `${i + 1}. ` : '- ';
      const body = kids(item).map(block).filter((s) => s !== '').join('\n');
      return body
        .split('\n')
        .map((line, at) => (at === 0 ? marker + line : ' '.repeat(marker.length) + line))
        .join('\n');
    })
    .join('\n');
}

function table(n: AdfNode): string {
  const rows = kids(n)
    .filter((r) => r.type === 'tableRow')
    .map((r) => kids(r).map((cell) => blocks(kids(cell)).replace(/\s*\n+\s*/g, ' ').replace(/\|/g, '\\|')));
  if (rows.length === 0) {
    return '';
  }
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  const out = [line(rows[0]), line(rows[0].map(() => '---')), ...rows.slice(1).map(line)];
  return out.join('\n');
}

function attachment(n: AdfNode): string {
  const name = str(n.attrs?.alt);
  return name ? `[attachment: ${name}]` : '[attachment]';
}

function inline(nodes: AdfNode[]): string {
  return nodes.map(inlineNode).join('');
}

function inlineNode(n: AdfNode): string {
  switch (n.type) {
    case 'text':
      return marked(str(n.text) ?? '', n.marks);
    case 'hardBreak':
      return '\n';
    case 'mention':
      return str(n.attrs?.text) ?? '@user';
    case 'inlineCard':
      return str(n.attrs?.url) ?? '';
    case 'emoji':
      return str(n.attrs?.text) ?? str(n.attrs?.shortName) ?? '';
    case 'status':
      return str(n.attrs?.text) ?? '';
    case 'date': {
      const ts = Number(n.attrs?.timestamp);
      return Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : '';
    }
    default:
      return inline(kids(n));
  }
}

function marked(text: string, marks: unknown): string {
  if (text === '' || !Array.isArray(marks)) {
    return text;
  }
  let out = text;
  const types = marks.filter(isNode);
  if (types.some((m) => m.type === 'code')) {
    out = `\`${out}\``;
  }
  if (types.some((m) => m.type === 'strong')) {
    out = `**${out}**`;
  }
  if (types.some((m) => m.type === 'em')) {
    out = `_${out}_`;
  }
  if (types.some((m) => m.type === 'strike')) {
    out = `~~${out}~~`;
  }
  const link = types.find((m) => m.type === 'link');
  const href = str(link?.attrs?.href);
  return href ? `[${out}](${href})` : out;
}
