import { Session, SessionTicket } from '../sessions/model';
import { Snapshot } from '../tickets/snapshot';
import { Ticket, TicketSourceConfig } from '../tickets/source';

export interface TicketGroup {
  ticket: Ticket | SessionTicket;
  listed: boolean; // false = only known from a session, no longer in the tracker's list
  sessions: Session[];
}

export interface SourceGroup {
  cfg: TicketSourceConfig;
  snap?: Snapshot;
  tickets: TicketGroup[];
}

export interface WorkModel {
  sources: SourceGroup[];
  // Ad-hoc sessions plus sessions whose ticket source is no longer configured.
  other: Session[];
}

// Keeps tickets whose id, title or status contains the text (case-insensitive). Tickets with sessions
// always stay, so running work never disappears behind a filter. Empty text: no filtering.
export function filterWork(model: WorkModel, text: string): WorkModel {
  const needle = text.trim().toLowerCase();
  if (!needle) {
    return model;
  }
  const matches = (g: TicketGroup) => {
    const status = 'status' in g.ticket ? g.ticket.status : undefined;
    return [g.ticket.id, g.ticket.title, status].some((v) => v?.toLowerCase().includes(needle));
  };
  return {
    ...model,
    sources: model.sources.map((s) => ({ ...s, tickets: s.tickets.filter((g) => g.sessions.length > 0 || matches(g)) })),
  };
}

// Pure: decides where every session shows up in the tree. snapshots[i] belongs to sources[i].
export function groupWork(sources: TicketSourceConfig[], snapshots: (Snapshot | undefined)[], sessions: Session[]): WorkModel {
  const configured = new Set(sources.map((s) => s.name));
  const groups = sources.map((cfg, i) => {
    const mine = sessions.filter((s) => s.ticket?.source === cfg.name);
    const listed: TicketGroup[] = (snapshots[i]?.tickets ?? []).map((ticket) => ({
      ticket,
      listed: true,
      sessions: mine.filter((s) => s.ticket!.id === ticket.id),
    }));
    const listedIds = new Set(listed.map((g) => g.ticket.id));
    const unlisted = new Map<string, TicketGroup>();
    for (const s of mine) {
      if (listedIds.has(s.ticket!.id)) {
        continue;
      }
      const group = unlisted.get(s.ticket!.id) ?? { ticket: s.ticket!, listed: false, sessions: [] };
      group.sessions.push(s);
      unlisted.set(s.ticket!.id, group);
    }
    return { cfg, snap: snapshots[i], tickets: [...listed, ...unlisted.values()] };
  });
  const other = sessions.filter((s) => !s.ticket || !configured.has(s.ticket.source));
  return { sources: groups, other };
}
