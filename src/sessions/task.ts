import { Ticket } from '../tickets/source';

// TASK.md is the agent's starting prompt; it is a pure function of the ticket.
// The raw tracker item is included as-is, since body fields differ per tracker.
export function renderTicketTask(ticket: Ticket): string {
  const lines = [`# ${ticket.id}: ${ticket.title}`, '', `- Source: ${ticket.source}`];
  if (ticket.status) {
    lines.push(`- Status: ${ticket.status}`);
  }
  if (ticket.url) {
    lines.push(`- URL: ${ticket.url}`);
  }
  lines.push('', '## Tracker data', '', '```json', JSON.stringify(ticket.raw, null, 2), '```', '');
  return lines.join('\n');
}

export function renderAdhocTask(title: string, description: string): string {
  return `# ${title}\n\n${description}\n`;
}
