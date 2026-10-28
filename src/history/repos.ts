// Which repository a session's folder belongs to, so the Usage tab can say
// "myApp" rather than list a worktree, a subfolder and a checkout of it
// as three projects. The name is the repository's folder: found from the
// nearest `.git` up the tree, where a worktree's `.git` file points back to
// the main checkout. Temporary folders (a headless run's scratch space)
// group as Scratch; a folder outside any repository is named by where it
// sits under home ("Desktop", "Developer"). Main process and CLI only: it
// reads the disk, and only names, never paths, leave it.

import * as fs from 'node:fs';
import * as path from 'node:path';

export const SCRATCH = 'Scratch';

const TEMP = /^\/(private\/)?(tmp|var\/folders|var\/tmp)(\/|$)/;

// Common layouts for worktrees kept away from their repository, for a folder
// that is gone from disk: `.../worktrees/<repo>/<name>` and
// `.../worktrees/<owner>/<repo>/<name>`.
const WORKTREE = [/\/\.[^/]+\/worktrees\/([^/]+)\//, /\/worktrees\/[^/]+\/([^/]+)\/[^/]+/];

function fromGit(dir: string, home: string): string | null {
  for (let d = dir; d !== path.dirname(d) && d !== home; d = path.dirname(d)) {
    const dotGit = path.join(d, '.git');
    let stat: fs.Stats;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      continue;
    }
    if (stat.isDirectory()) return path.basename(d);
    try {
      // "gitdir: /repo/.git/worktrees/<name>": the repository is the folder
      // holding that .git.
      const gitdir = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'))?.[1]?.trim();
      if (!gitdir) return path.basename(d);
      const common = path.resolve(d, gitdir).replace(/[/\\]worktrees[/\\][^/\\]+$/, '');
      return path.basename(path.dirname(common));
    } catch {
      return path.basename(d);
    }
  }
  return null;
}

export function repoName(cwd: string | null, home: string): string {
  if (!cwd) return 'Unknown';
  if (TEMP.test(cwd) && cwd !== home && !cwd.startsWith(home + path.sep)) return SCRATCH;
  const git = fromGit(cwd, home);
  if (git) return git;
  for (const re of WORKTREE) {
    const m = re.exec(cwd);
    if (m) return m[1];
  }
  const rel = path.relative(home, cwd);
  if (!rel) return 'Home';
  if (rel.startsWith('..')) return path.basename(cwd) || cwd;
  return rel.split(path.sep)[0];
}

// One lookup per folder: a report names thousands of sessions in a few
// hundred folders.
export function repoNamer(home: string): (cwd: string | null) => string {
  const seen = new Map<string | null, string>();
  return (cwd) => {
    let name = seen.get(cwd);
    if (name === undefined) {
      name = repoName(cwd, home);
      seen.set(cwd, name);
    }
    return name;
  };
}
