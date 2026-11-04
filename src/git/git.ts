import { execFile } from 'child_process';

export class GitError extends Error {
  constructor(message: string, readonly stderr: string) {
    super(message);
  }
}

// Runs git without a shell, so arguments are never interpreted by one.
export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new GitError(`git ${args.join(' ')} failed: ${stderr.trim() || err.message}`, stderr));
      } else {
        resolve(stdout);
      }
    });
  });
}
