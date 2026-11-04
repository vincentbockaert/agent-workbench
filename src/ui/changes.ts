import * as path from 'path';
import * as vscode from 'vscode';
import { decodeBaseQuery, encodeBaseQuery, fileAtRef, mergeBase } from '../git/diff';
import { ChangedFile, ChangeStatus } from '../git/worktree';
import { Session } from '../sessions/model';
import { sessionForPath } from '../time/rules';

const CHANGE_SCHEME = 'wb-change';
const BASE_SCHEME = 'wb-base';

export function changeUri(file: ChangedFile): vscode.Uri {
  return vscode.Uri.from({ scheme: CHANGE_SCHEME, path: `/${file.path}`, query: file.status });
}

const DECORATIONS: Record<ChangeStatus, { badge: string; color: string }> = {
  added: { badge: 'A', color: 'gitDecoration.addedResourceForeground' },
  modified: { badge: 'M', color: 'gitDecoration.modifiedResourceForeground' },
  deleted: { badge: 'D', color: 'gitDecoration.deletedResourceForeground' },
  untracked: { badge: 'U', color: 'gitDecoration.untrackedResourceForeground' },
};

// Base-side documents for diffs, read straight from git at the session's merge base.
class BaseContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const q = decodeBaseQuery(uri.query);
    if (!q || q.ref === '') {
      return ''; // the empty side of an added or deleted file
    }
    return fileAtRef(q.worktree, q.ref, q.path);
  }
}

export function registerChangeProviders(): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, new BaseContentProvider()),
    vscode.window.registerFileDecorationProvider({
      provideFileDecoration(uri) {
        if (uri.scheme !== CHANGE_SCHEME) {
          return undefined;
        }
        const d = DECORATIONS[uri.query as ChangeStatus];
        return d && new vscode.FileDecoration(d.badge, undefined, new vscode.ThemeColor(d.color));
      },
    }),
  );
}

// Side-by-side diff: base (merge base) on the left, the worktree file on the right.
export async function openChange(session: Session, file: ChangedFile): Promise<void> {
  const ref = await mergeBase(session.worktree, session.baseRef);
  const side = (r: string) => vscode.Uri.from({ scheme: BASE_SCHEME, path: `/${file.path}`, query: encodeBaseQuery({ worktree: session.worktree, ref: r, path: file.path }) });
  const left = file.status === 'added' || file.status === 'untracked' ? side('') : side(ref);
  const right = file.status === 'deleted' ? side('') : vscode.Uri.file(path.join(session.worktree, file.path));
  await vscode.commands.executeCommand('vscode.diff', left, right, `${path.basename(file.path)} (base ↔ ${session.id})`, { preview: true });
}

// The session an editor belongs to: its worktree file, or a base-side document of its diff.
export function sessionForEditor(sessions: Session[], editor: vscode.TextEditor | undefined): Session | undefined {
  const uri = editor?.document.uri;
  if (!uri) {
    return undefined;
  }
  if (uri.scheme === BASE_SCHEME) {
    const q = decodeBaseQuery(uri.query);
    return q && sessionForPath(sessions, q.worktree, process.platform === 'win32');
  }
  return uri.scheme === 'file' ? sessionForPath(sessions, uri.fsPath, process.platform === 'win32') : undefined;
}
