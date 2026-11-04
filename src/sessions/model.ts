// The ticket fields a session keeps, so it still renders after the ticket leaves the tracker's list.
export interface SessionTicket {
  source: string;
  id: string;
  title: string;
  url?: string;
}

export interface Session {
  id: string; // equals the worktree slug, unique because the branch wb/<id> is unique
  repo: string;
  worktree: string;
  branch: string;
  baseRef: string;
  createdAt: string;
  ticket?: SessionTicket; // undefined = ad-hoc session
  title?: string; // ad-hoc sessions only
}

// Base slug (without the "-<n>" counter) for a ticket or ad-hoc session.
export function sessionSlugBase(ticket: SessionTicket | undefined, adhocTitle?: string): string {
  const parts = ticket ? [slugify(ticket.source) || 'ticket', slugify(ticket.id)] : ['adhoc', slugify(adhocTitle ?? '')];
  return trimEnd(parts.filter(Boolean).join('-').slice(0, MAX_SLUG_BASE));
}

// Leaves room for the "-<n>" counter within a readable folder/branch name.
const MAX_SLUG_BASE = 40;

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+/, '')
    .replace(/[-._]+$/, '');
}

function trimEnd(s: string): string {
  return s.replace(/[-._]+$/, '');
}
