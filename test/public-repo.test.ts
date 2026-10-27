// The repository is public, so nothing tracked may carry someone's private
// details: links into private chats, real email addresses, real home folders,
// or names that only mean something on one person's machine. Fixtures use
// example domains and placeholder people (me, someone, demo) instead.
//
// The generic patterns live here. Names that are private in themselves (a
// client, a group id) cannot be written down in a public test, so they go one
// per line in a file outside the repository: SWITCHBOARD_PRIVATE_WORDS, or
// ~/.config/switchboard/private-words. CI has no such file and checks only
// the patterns.
import { test, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const root = path.resolve(__dirname, '..');
const BINARY = /\.(png|jpe?g|gif|webp|icns|ico|mp4|mov|woff2?|ttf|otf|pdf|zip|gz)$/i;

const PLACEHOLDER_USERS = new Set(['me', 'someone', 'demo', 'you', "o'brien", 'runner', 'user']);
// Reserved names (RFC 2606) anywhere in the domain, which also covers fixture
// file names such as `claude-expired@example.test.json`.
const RESERVED_LABELS = new Set(['example', 'test', 'invalid', 'localhost']);
const allowedEmail = (address: string) => {
  const domain = address.split('@')[1].toLowerCase();
  return domain.endsWith('users.noreply.github.com') || domain.split('.').some((label) => RESERVED_LABELS.has(label));
};

const RULES: { name: string; find: (text: string) => string[] }[] = [
  {
    // Private Telegram groups (`c/` and a numeric id) and invite links (`+` or
    // `joinchat/` and a code).
    name: 'private chat link',
    find: (text) => text.match(/t\.me\/(?:c\/\d|\+[\w-]|joinchat\/[\w-])\S*/g) ?? [],
  },
  {
    name: 'real email address',
    find: (text) =>
      (text.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g) ?? []).filter(
        // `name@2x.png` is an image, not an address.
        (found) => !allowedEmail(found) && !/@\d+x\./.test(found),
      ),
  },
  {
    name: 'real home folder',
    find: (text) =>
      [...text.matchAll(/\/(?:Users|home)\/([A-Za-z0-9._'-]+)/g)]
        // A shell-quoted `/Users/o'\''brien` splits at the first quote.
        .filter(([, user]) => !PLACEHOLDER_USERS.has(user.replace(/'$/, '')) && user !== "o'")
        .map(([found]) => found),
  },
];

function privateWords(): string[] {
  const file =
    process.env.SWITCHBOARD_PRIVATE_WORDS ??
    // The test preload swaps HOME for a sandbox; the account's real home is
    // where this file lives.
    path.join(os.userInfo().homedir, '.config', 'switchboard', 'private-words');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((file) => file && !BINARY.test(file) && file !== 'bun.lock');
}

test('no tracked file carries private details', () => {
  const words = privateWords().map((word) => word.toLowerCase());
  const found: string[] = [];
  for (const file of trackedFiles()) {
    const full = path.join(root, file);
    // A file deleted in the working tree is still listed until committed.
    if (!fs.existsSync(full)) continue;
    const text = fs.readFileSync(full, 'utf8');
    for (const rule of RULES) for (const hit of rule.find(text)) found.push(`${file}: ${rule.name}: ${hit}`);
    const lower = text.toLowerCase();
    // Never print the word itself: the output may end up in a public CI log.
    for (const [i, word] of words.entries()) if (lower.includes(word)) found.push(`${file}: private word #${i + 1}`);
    if (words.some((word) => file.toLowerCase().includes(word))) found.push(`${file}: private word in path`);
  }
  expect(found).toEqual([]);
});
