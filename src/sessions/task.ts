import { adfToText } from '../tickets/adf';
import { Ticket } from '../tickets/source';

// TASK.md is the agent's starting prompt; it is a pure function of the ticket.
// The mapped description gets its own section; the raw tracker item is included as-is after it, since body fields differ per tracker.
export function renderTicketTask(ticket: Ticket): string {
  const lines = [`# ${ticket.id}: ${ticket.title}`, '', `- Source: ${ticket.source}`];
  if (ticket.status) {
    lines.push(`- Status: ${ticket.status}`);
  }
  if (ticket.url) {
    lines.push(`- URL: ${ticket.url}`);
  }
  const description = ticket.description?.trim();
  if (description) {
    lines.push('', '## Description', '', description);
  }
  lines.push('', '## Tracker data', '', '```json', JSON.stringify(ticket.raw, dedupe(description), 2), '```', '');
  return lines.join('\n');
}

// The description is already rendered above as text, so the same rich-text document is not dumped again in the raw data.
// Other rich-text fields stay, because their content is not shown anywhere else.
function dedupe(description: string | undefined): ((key: string, value: unknown) => unknown) | undefined {
  if (!description) {
    return undefined;
  }
  return (_key, value) => (adfToText(value) === description ? '(rendered above in the Description section)' : value);
}

export function renderAdhocTask(title: string, description: string): string {
  return `# ${title}\n\n${description}\n`;
}
