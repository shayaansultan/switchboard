import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sandboxHome } from './setup';
import { repoName, SCRATCH } from '../src/history/repos';

const home = path.join(sandboxHome, 'repos-test');
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

test('a folder is named by its repository, a worktree by the one it belongs to', () => {
  const repo = path.join(home, 'Developer', 'shop');
  fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'fix'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'web', 'src'), { recursive: true });
  const tree = path.join(home, 'elsewhere', 'fix');
  fs.mkdirSync(tree, { recursive: true });
  fs.writeFileSync(path.join(tree, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'fix')}\n`);
  expect(repoName(path.join(repo, 'web', 'src'), home)).toBe('shop');
  expect(repoName(tree, home)).toBe('shop');
});

test('temporary folders are Scratch; a gone worktree and a plain folder still get a name', () => {
  expect(repoName('/private/tmp/claude-501/run', home)).toBe(SCRATCH);
  expect(repoName('/var/folders/pb/x/T/run', home)).toBe(SCRATCH);
  expect(repoName(path.join(home, '.t3', 'worktrees', 'shop', 'branch-1'), home)).toBe('shop');
  expect(repoName(path.join(home, 'Developer', 'worktrees', 'claude', 'shop', 'tab'), home)).toBe('shop');
  expect(repoName(path.join(home, 'Desktop', 'notes'), home)).toBe('Desktop');
  expect(repoName(home, home)).toBe('Home');
  expect(repoName(null, home)).toBe('Unknown');
});
