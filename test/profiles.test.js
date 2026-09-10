// Tests for the profile store. The invariant that matters most is isolation:
// a profile must never read another profile's login, and Switchboard must
// never write into a Default profile's real directories.
//
// profiles.js resolves the home directory once at import, so HOME is pointed
// at a scratch directory before the module loads.

const { test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-test-')));
process.env.HOME = SANDBOX;

const profiles = require('../src/profiles');

// Every test deletes directories. If the module did not pick up the sandbox
// home, those deletes would land on the real ~/.switchboard, so stop here
// rather than run a single test against live data.
if (!profiles.ROOT.startsWith(SANDBOX + path.sep)) {
  throw new Error(`refusing to run: profile root is ${profiles.ROOT}, outside the sandbox ${SANDBOX}`);
}

const CLAUDE_HOME = path.join(SANDBOX, '.claude');
const CODEX_HOME = path.join(SANDBOX, '.codex');

function reset() {
  for (const p of [profiles.ROOT, CLAUDE_HOME, CODEX_HOME, path.join(SANDBOX, '.claude.json')]) {
    if (!p.startsWith(SANDBOX + path.sep)) throw new Error(`refusing to delete ${p}: outside the sandbox`);
    fs.rmSync(p, { recursive: true, force: true });
  }
  fs.mkdirSync(CLAUDE_HOME, { recursive: true });
  fs.mkdirSync(CODEX_HOME, { recursive: true });
}

beforeEach(reset);
afterEach(reset);

const claudeSource = () => profiles.load().profiles.find((p) => p.id === 'claude-default');
const codexSource = () => profiles.load().profiles.find((p) => p.id === 'codex-default');

test('the sandbox is in effect, so no test can touch the real home', () => {
  expect(profiles.ROOT.startsWith(SANDBOX)).toBe(true);
  expect(profiles.VENDORS.claude.defaultHome).toBe(CLAUDE_HOME);
});

// ---- isolation ----

test('Default profiles resolve to the real vendor directories', () => {
  const d = profiles.dirs(claudeSource());
  expect(d.isDefault).toBe(true);
  expect(d.home).toBe(CLAUDE_HOME);
});

test('every other profile lives under the Switchboard root, one directory each', () => {
  const data = profiles.load();
  const a = profiles.add(data, { vendor: 'claude', name: 'Work' }).profile;
  const b = profiles.add(data, { vendor: 'claude', name: 'Personal' }).profile;
  for (const p of [a, b]) {
    expect(profiles.dirs(p).home.startsWith(profiles.ROOT + path.sep)).toBe(true);
    expect(profiles.dirs(p).home).not.toBe(CLAUDE_HOME);
  }
  expect(profiles.dirs(a).home).not.toBe(profiles.dirs(b).home);
  expect(profiles.dirs(a).desktop).not.toBe(profiles.dirs(b).desktop);
});

test('two profiles named the same get separate directories', () => {
  const data = profiles.load();
  const a = profiles.add(data, { vendor: 'claude', name: 'Work' }).profile;
  const b = profiles.add(data, { vendor: 'claude', name: 'Work' }).profile;
  expect(a.id).not.toBe(b.id);
  expect(profiles.dirs(a).home).not.toBe(profiles.dirs(b).home);
});

test('bringOver refuses a Default target, a different app, and itself', () => {
  const data = profiles.load();
  const work = profiles.add(data, { vendor: 'claude', name: 'Work' }).profile;
  expect(() => profiles.bringOver(data, claudeSource(), work, { items: ['skills'] })).toThrow();
  expect(() => profiles.bringOver(data, work, codexSource(), { items: ['skills'] })).toThrow();
  expect(() => profiles.bringOver(data, work, work, { items: ['skills'] })).toThrow();
});

test('removing a profile with its data deletes only inside the Switchboard root', () => {
  const data = profiles.load();
  const work = profiles.add(data, { vendor: 'claude', name: 'Work' }).profile;
  fs.writeFileSync(path.join(CLAUDE_HOME, 'CLAUDE.md'), 'personal instructions');
  profiles.bringOver(data, work, claudeSource(), { items: ['instructions'], mode: 'link' });

  profiles.remove(data, work.id, { deleteData: true });

  expect(fs.existsSync(profiles.dirs(work).home)).toBe(false);
  // Deleting through a symlink must not reach the source file.
  expect(fs.readFileSync(path.join(CLAUDE_HOME, 'CLAUDE.md'), 'utf8')).toBe('personal instructions');
});

test('a Default profile cannot be removed', () => {
  const data = profiles.load();
  expect(() => profiles.remove(data, 'claude-default', { deleteData: true })).toThrow();
});

// ---- bringing things over ----

test('link mode symlinks to the source; copy mode makes independent files', () => {
  fs.mkdirSync(path.join(CLAUDE_HOME, 'skills', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(CLAUDE_HOME, 'skills', 'demo', 'SKILL.md'), 'v1');

  const data = profiles.load();
  const linked = profiles.add(data, { vendor: 'claude', name: 'Linked', sourceId: 'claude-default', items: ['skills'], mode: 'link' }).profile;
  const copied = profiles.add(data, { vendor: 'claude', name: 'Copied', sourceId: 'claude-default', items: ['skills'], mode: 'copy' }).profile;

  const linkedSkills = path.join(profiles.dirs(linked).home, 'skills');
  const copiedSkills = path.join(profiles.dirs(copied).home, 'skills');
  expect(fs.lstatSync(linkedSkills).isSymbolicLink()).toBe(true);
  expect(fs.lstatSync(copiedSkills).isSymbolicLink()).toBe(false);

  // Editing the source reaches the linked profile and not the copied one.
  fs.writeFileSync(path.join(CLAUDE_HOME, 'skills', 'demo', 'SKILL.md'), 'v2');
  expect(fs.readFileSync(path.join(linkedSkills, 'demo', 'SKILL.md'), 'utf8')).toBe('v2');
  expect(fs.readFileSync(path.join(copiedSkills, 'demo', 'SKILL.md'), 'utf8')).toBe('v1');
});

test('bringing something over never overwrites what the profile already has', () => {
  fs.writeFileSync(path.join(CLAUDE_HOME, 'CLAUDE.md'), 'from source');
  const data = profiles.load();
  const work = profiles.add(data, { vendor: 'claude', name: 'Work' }).profile;
  fs.writeFileSync(path.join(profiles.dirs(work).home, 'CLAUDE.md'), 'mine');

  const out = profiles.bringOver(data, work, claudeSource(), { items: ['instructions'], mode: 'link' });

  expect(fs.readFileSync(path.join(profiles.dirs(work).home, 'CLAUDE.md'), 'utf8')).toBe('mine');
  expect(out.skipped.map((s) => s.item)).toContain('CLAUDE.md');
});

test('a folder the app already populated gets the source entries merged in', () => {
  fs.mkdirSync(path.join(CLAUDE_HOME, 'skills', 'shared'), { recursive: true });
  const data = profiles.load();
  const work = profiles.add(data, { vendor: 'claude', name: 'Work' }).profile;
  const dstSkills = path.join(profiles.dirs(work).home, 'skills');
  fs.mkdirSync(path.join(dstSkills, 'own'), { recursive: true });

  profiles.bringOver(data, work, claudeSource(), { items: ['skills'], mode: 'link' });

  expect(fs.existsSync(path.join(dstSkills, 'own'))).toBe(true);
  expect(fs.lstatSync(path.join(dstSkills, 'shared')).isSymbolicLink()).toBe(true);
});

// ---- credentials and connectors must not travel ----

test('copied Claude preferences drop every credential-bearing key', () => {
  fs.writeFileSync(path.join(CLAUDE_HOME, 'settings.json'), JSON.stringify({
    model: 'opus',
    env: { ANTHROPIC_API_KEY: 'sk-ant-should-not-travel' },
    apiKeyHelper: '/bin/echo secret',
    awsAuthRefresh: 'aws sso login',
    enabledPlugins: { 'x@y': true },
    extraKnownMarketplaces: { m: {} },
  }));

  const data = profiles.load();
  const work = profiles.add(data, { vendor: 'claude', name: 'Work', sourceId: 'claude-default', items: ['preferences'] }).profile;
  const copied = JSON.parse(fs.readFileSync(path.join(profiles.dirs(work).home, 'settings.json'), 'utf8'));

  expect(copied.model).toBe('opus');
  for (const k of [...profiles.CLAUDE_SECRET_KEYS, 'enabledPlugins', 'extraKnownMarketplaces']) {
    expect(copied[k]).toBeUndefined();
  }
});

test('copied Codex preferences drop connectors, plugins and marketplaces', () => {
  fs.writeFileSync(path.join(CODEX_HOME, 'config.toml'), [
    'model = "gpt-6"',
    'approval_policy = "on-request"',
    '',
    '[mcp_servers.slack]',
    'command = "slack-mcp"',
    '',
    '[plugins."thing@market"]',
    'enabled = true',
    '',
    '[marketplaces.market]',
    'source = "local"',
    '',
    '[features]',
    'memories = true',
  ].join('\n'));

  const data = profiles.load();
  const work = profiles.add(data, { vendor: 'codex', name: 'Work', sourceId: 'codex-default', items: ['preferences'] }).profile;
  const copied = fs.readFileSync(path.join(profiles.dirs(work).home, 'config.toml'), 'utf8');

  expect(copied).toContain('model = "gpt-6"');
  expect(copied).toContain('[features]');
  expect(copied).not.toContain('mcp_servers');
  expect(copied).not.toContain('slack-mcp');
  expect(copied).not.toContain('marketplaces');
});

test('connectors travel only when explicitly asked for', () => {
  fs.writeFileSync(path.join(CODEX_HOME, 'config.toml'), 'model = "gpt-6"\n\n[mcp_servers.slack]\ncommand = "slack-mcp"\n');

  const data = profiles.load();
  const work = profiles.add(data, { vendor: 'codex', name: 'Work', sourceId: 'codex-default', items: ['preferences'] }).profile;
  const dst = path.join(profiles.dirs(work).home, 'config.toml');
  expect(fs.readFileSync(dst, 'utf8')).not.toContain('slack-mcp');

  profiles.bringOver(data, work, codexSource(), { items: ['connectors'] });
  expect(fs.readFileSync(dst, 'utf8')).toContain('slack-mcp');
});

test('Claude connectors are read from where Claude Code actually keeps them', () => {
  // The Default profile keeps .claude.json in the home directory, not inside
  // ~/.claude; every other profile keeps it inside its config directory.
  expect(profiles.claudeJsonPath(CLAUDE_HOME)).toBe(path.join(SANDBOX, '.claude.json'));
  expect(profiles.claudeJsonPath('/tmp/other')).toBe('/tmp/other/.claude.json');

  fs.writeFileSync(path.join(SANDBOX, '.claude.json'), JSON.stringify({ mcpServers: { notion: { command: 'notion-mcp' } } }));
  const data = profiles.load();
  const work = profiles.add(data, { vendor: 'claude', name: 'Work', sourceId: 'claude-default', items: ['connectors'] }).profile;

  const dst = JSON.parse(fs.readFileSync(path.join(profiles.dirs(work).home, '.claude.json'), 'utf8'));
  expect(dst.mcpServers.notion.command).toBe('notion-mcp');
});

// ---- vendor filenames that change between releases ----

test('versioned database names are matched by prefix, not hardcoded', () => {
  fs.writeFileSync(path.join(CODEX_HOME, 'thread_history_7.sqlite'), 'db');
  fs.writeFileSync(path.join(CODEX_HOME, 'thread_history_7.sqlite-wal'), 'wal');
  fs.writeFileSync(path.join(CODEX_HOME, 'unrelated.sqlite'), 'no');

  const expanded = profiles.expandPaths(['history.jsonl', 'thread_history_*'], CODEX_HOME);
  expect(expanded).toContain('thread_history_7.sqlite');
  expect(expanded).toContain('thread_history_7.sqlite-wal');
  expect(expanded).not.toContain('unrelated.sqlite');
  expect(expanded).toContain('history.jsonl'); // literal entries survive
});

test('chat history is copied even when the schema number has moved on', () => {
  fs.writeFileSync(path.join(CODEX_HOME, 'thread_history_9.sqlite'), 'threads');
  fs.mkdirSync(path.join(CODEX_HOME, 'sessions', '2026'), { recursive: true });
  fs.writeFileSync(path.join(CODEX_HOME, 'sessions', '2026', 'a.jsonl'), 'session');

  const data = profiles.load();
  const work = profiles.add(data, { vendor: 'codex', name: 'Work', sourceId: 'codex-default', items: ['history'], mode: 'link' }).profile;
  const home = profiles.dirs(work).home;

  expect(fs.readFileSync(path.join(home, 'thread_history_9.sqlite'), 'utf8')).toBe('threads');
  // History is copied even when link mode was chosen, so the two accounts
  // cannot corrupt each other's session list.
  expect(fs.lstatSync(path.join(home, 'thread_history_9.sqlite')).isSymbolicLink()).toBe(false);
  expect(fs.readFileSync(path.join(home, 'sessions', '2026', 'a.jsonl'), 'utf8')).toBe('session');
});

// ---- the store itself ----

test('an unreadable store is preserved rather than overwritten', () => {
  const data = profiles.load();
  profiles.add(data, { vendor: 'claude', name: 'Work' });
  const store = path.join(profiles.ROOT, 'profiles.json');
  fs.writeFileSync(store, '{ this is not json');

  const recovered = profiles.load();

  expect(recovered.loadError).toBeTruthy();
  expect(recovered.profiles.length).toBe(2); // back to the two Defaults
  const backups = fs.readdirSync(profiles.ROOT).filter((f) => f.startsWith('profiles.json.corrupt-'));
  expect(backups.length).toBe(1);
  expect(fs.readFileSync(path.join(profiles.ROOT, backups[0]), 'utf8')).toBe('{ this is not json');
});

test('the store survives a round trip and never persists the load error', () => {
  const data = profiles.load();
  profiles.add(data, { vendor: 'codex', name: 'Client X' });
  const again = profiles.load();
  expect(again.profiles.map((p) => p.name)).toContain('Client X');
  expect(Object.keys(JSON.parse(fs.readFileSync(path.join(profiles.ROOT, 'profiles.json'), 'utf8')))).not.toContain('loadError');
});

// ---- launch arguments ----
// Regression guard: a non-default profile needs the Chromium flag AND the
// config-home variable. The flag alone isolates the signed-in session but
// leaves the app's embedded agent writing into the default home, which fails
// silently rather than visibly.

const launch = require('../src/launch');

test('a non-default profile is launched with both isolations, for both apps', () => {
  const data = profiles.load();
  for (const vendor of ['claude', 'codex']) {
    const p = profiles.add(data, { vendor, name: 'Second' }).profile;
    const args = launch.launchArgs(p, false);
    const d = profiles.dirs(p);

    expect(args).toContain('--env');
    expect(args).toContain(`${profiles.VENDORS[vendor].homeEnv}=${d.home}`);
    expect(args).toContain(`--user-data-dir=${d.desktop}`);
    expect(args).toContain('-n'); // never reuse the running instance
  }
});

test('a Default profile is launched untouched, with no redirection', () => {
  const args = launch.launchArgs(claudeSource(), false);
  expect(args).toEqual(['-n', '-a', profiles.VENDORS.claude.appPath]);
  // Already running: focus it rather than starting a second copy.
  expect(launch.launchArgs(claudeSource(), true)).toEqual(['-a', profiles.VENDORS.claude.appPath]);
});

// ---- Codex project grouping ----
// The desktop app's sidebar state lives in .codex-global-state.json next to
// the sessions. Only the keys that place threads may travel; the rest of that
// file identifies this machine and this install.

const GS = profiles.CODEX_GLOBAL_STATE;
const ANSWER = { id: 'p-answer', name: 'answerThis', rootPaths: ['/w/answerThis'], createdAt: 1, updatedAt: 1 };
const AGENTS = { id: 'p-agents', name: 'agentfiles', rootPaths: ['/w/agentfiles'], createdAt: 2, updatedAt: 2 };
const SOURCE_STATE = {
  'local-projects': { 'p-answer': ANSWER, 'p-agents': AGENTS },
  'project-order': ['p-agents', 'p-answer'],
  'thread-project-assignments': {
    't-wt': { projectKind: 'local', projectId: 'p-answer' },
    't-ag': { projectKind: 'local', projectId: 'p-agents' },
    't-remote': { projectKind: 'remote', projectId: 'r-1' },
    't-orphan': { projectKind: 'local', projectId: 'p-gone' },
  },
  'projectless-thread-ids': ['t-loose'],
  'pinned-thread-ids': ['t-wt'],
  'thread-workspace-root-hints': { 't-loose': '/w/Documents' },
  'thread-projectless-output-directories': { 't-loose': '/w/Documents/outputs' },
  'sidebar-project-thread-orders': { 'p-answer': ['t-wt'] },
  'project-appearances': { 'p-answer': { color: 'blue' } },
  // Must never travel.
  'electron-main-window-bounds': { x: 1, y: 2, width: 3, height: 4 },
  'electron-mac-push-deregistration-token': 'secret-token',
  'electron-local-remote-control-installation-id': 'this-machine',
  'app-server-projects-migration-by-host': { 'local:/src': { version: 1, projectsMigrated: true } },
  'app-server-project-id-by-legacy-project-id-by-host': { 'local:/src': { 'p-answer': 'srv-1' } },
  'thread-writable-roots': { 't-wt': ['/w/answerThis'] },
};

function writeSourceState(state = SOURCE_STATE) {
  fs.mkdirSync(path.join(CODEX_HOME, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(CODEX_HOME, GS), JSON.stringify(state));
}

test('Codex chat history carries the project grouping, and nothing that identifies the machine', () => {
  writeSourceState();
  const data = profiles.load();
  const { profile, result } = profiles.add(data, { vendor: 'codex', name: 'Work', sourceId: 'codex-default', items: ['history'], mode: 'copy' });
  const got = JSON.parse(fs.readFileSync(path.join(profiles.dirs(profile).home, GS), 'utf8'));
  expect(got['local-projects']).toEqual(SOURCE_STATE['local-projects']);
  expect(got['project-order']).toEqual(['p-agents', 'p-answer']);
  expect(got['thread-project-assignments']).toEqual({
    't-wt': { projectKind: 'local', projectId: 'p-answer' },
    't-ag': { projectKind: 'local', projectId: 'p-agents' },
  });
  expect(got['projectless-thread-ids']).toEqual(['t-loose']);
  expect(got['pinned-thread-ids']).toEqual(['t-wt']);
  expect(got['thread-workspace-root-hints']).toEqual({ 't-loose': '/w/Documents' });
  expect(got['thread-projectless-output-directories']).toEqual({ 't-loose': '/w/Documents/outputs' });
  expect(got['sidebar-project-thread-orders']).toEqual({ 'p-answer': ['t-wt'] });
  expect(got['project-appearances']).toEqual({ 'p-answer': { color: 'blue' } });
  for (const k of Object.keys(SOURCE_STATE)) {
    if (!profiles.CODEX_PROJECT_STATE_KEYS.includes(k)) expect(got).not.toHaveProperty(k);
  }
  expect(Object.keys(got).sort()).toEqual([...profiles.CODEX_PROJECT_STATE_KEYS].sort());
  expect(result.done.some((d) => d.startsWith('project grouping'))).toBe(true);
  // A hard copy of the source, not a link to it.
  expect(fs.lstatSync(path.join(profiles.dirs(profile).home, GS)).isSymbolicLink()).toBe(false);
});

test('a project the profile re-added by hand keeps its id, and the source references are rewritten to it', () => {
  writeSourceState();
  const data = profiles.load();
  const { profile } = profiles.add(data, { vendor: 'codex', name: 'Work' });
  const home = profiles.dirs(profile).home;
  const own = { id: 'p-mine', name: 'answerThis', rootPaths: ['/w/answerThis'], createdAt: 9, updatedAt: 9 };
  fs.writeFileSync(path.join(home, GS), JSON.stringify({
    'local-projects': { 'p-mine': own },
    'project-order': ['p-mine'],
    'thread-project-assignments': { 't-new': { projectKind: 'local', projectId: 'p-mine' } },
    'projectless-thread-ids': ['t-here'],
    'electron-main-window-bounds': { x: 5 },
    'app-server-project-id-by-legacy-project-id-by-host': { 'local:/dst': { 'p-mine': 'srv-9' } },
  }));
  profiles.bringOver(data, profile, codexSource(), { items: ['history'], mode: 'copy' });
  const got = JSON.parse(fs.readFileSync(path.join(home, GS), 'utf8'));
  expect(Object.keys(got['local-projects']).sort()).toEqual(['p-agents', 'p-mine']);
  expect(got['local-projects']['p-mine']).toEqual(own);
  expect(got['project-order']).toEqual(['p-mine', 'p-agents']);
  expect(got['thread-project-assignments']).toEqual({
    't-new': { projectKind: 'local', projectId: 'p-mine' },
    't-wt': { projectKind: 'local', projectId: 'p-mine' },
    't-ag': { projectKind: 'local', projectId: 'p-agents' },
  });
  expect(got['sidebar-project-thread-orders']).toEqual({ 'p-mine': ['t-wt'] });
  expect(got['project-appearances']).toEqual({ 'p-mine': { color: 'blue' } });
  expect(got['projectless-thread-ids']).toEqual(['t-here', 't-loose']);
  // The profile's own machine-specific keys are left exactly as they were.
  expect(got['electron-main-window-bounds']).toEqual({ x: 5 });
  expect(got['app-server-project-id-by-legacy-project-id-by-host']).toEqual({ 'local:/dst': { 'p-mine': 'srv-9' } });
  expect(got).not.toHaveProperty('electron-mac-push-deregistration-token');
});

test('projects without root folders are never folded into each other', () => {
  writeSourceState({ 'local-projects': { 'p-src-loose': { id: 'p-src-loose', name: 'Loose', createdAt: 1, updatedAt: 1 } }, 'project-order': ['p-src-loose'] });
  const data = profiles.load();
  const { profile } = profiles.add(data, { vendor: 'codex', name: 'Work' });
  const home = profiles.dirs(profile).home;
  fs.writeFileSync(path.join(home, GS), JSON.stringify({ 'local-projects': { 'p-dst-loose': { id: 'p-dst-loose', name: 'Other', createdAt: 2, updatedAt: 2 } }, 'project-order': ['p-dst-loose'] }));
  profiles.bringOver(data, profile, codexSource(), { items: ['history'], mode: 'copy' });
  const got = JSON.parse(fs.readFileSync(path.join(home, GS), 'utf8'));
  expect(Object.keys(got['local-projects']).sort()).toEqual(['p-dst-loose', 'p-src-loose']);
  expect(got['project-order']).toEqual(['p-dst-loose', 'p-src-loose']);
});

test('bringing the grouping over twice changes nothing the second time', () => {
  writeSourceState();
  const data = profiles.load();
  const { profile } = profiles.add(data, { vendor: 'codex', name: 'Work', sourceId: 'codex-default', items: ['history'], mode: 'copy' });
  const file = path.join(profiles.dirs(profile).home, GS);
  const before = fs.readFileSync(file, 'utf8');
  const r = profiles.bringOver(data, profile, codexSource(), { items: ['history'], mode: 'copy' });
  expect(fs.readFileSync(file, 'utf8')).toBe(before);
  expect(r.skipped).toContainEqual({ item: 'project grouping', reason: 'profile already has its own' });
});

test('the grouping travels only with chat history, and copes with a missing or broken source file', () => {
  writeSourceState();
  fs.writeFileSync(path.join(CODEX_HOME, 'AGENTS.md'), 'hi');
  const data = profiles.load();
  const a = profiles.add(data, { vendor: 'codex', name: 'A', sourceId: 'codex-default', items: ['instructions'], mode: 'copy' }).profile;
  expect(fs.existsSync(path.join(profiles.dirs(a).home, GS))).toBe(false);

  fs.rmSync(path.join(CODEX_HOME, GS));
  const b = profiles.add(data, { vendor: 'codex', name: 'B', sourceId: 'codex-default', items: ['history'], mode: 'copy' });
  expect(fs.existsSync(path.join(profiles.dirs(b.profile).home, GS))).toBe(false);
  expect(b.result.skipped).toEqual([]);

  fs.writeFileSync(path.join(CODEX_HOME, GS), '{not json');
  const c = profiles.add(data, { vendor: 'codex', name: 'C', sourceId: 'codex-default', items: ['history'], mode: 'copy' });
  expect(fs.existsSync(path.join(profiles.dirs(c.profile).home, GS))).toBe(false);
  expect(c.result.skipped.some((s) => s.item === 'project grouping')).toBe(true);
});

test('the Default Codex home is never written to when it is the target of nothing', () => {
  writeSourceState();
  const before = fs.readFileSync(path.join(CODEX_HOME, GS), 'utf8');
  const data = profiles.load();
  profiles.add(data, { vendor: 'codex', name: 'Work', sourceId: 'codex-default', items: ['history'], mode: 'copy' });
  expect(fs.readFileSync(path.join(CODEX_HOME, GS), 'utf8')).toBe(before);
});
