// Profile store. A profile is one account slot for one vendor.
// Each non-default profile owns an isolated directory tree under ~/.switchboard
// so its CLI login, desktop-app session, history and settings never touch
// another profile's.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Node's os.homedir() honours $HOME on POSIX; Bun reads the passwd entry
// instead. Prefer $HOME so tests can point the whole store at a scratch
// directory, and so an explicit HOME wins as it does everywhere else.
const HOME = process.env.HOME || os.homedir();
const ROOT = path.join(HOME, '.switchboard');
const STORE = path.join(ROOT, 'profiles.json');

const VENDORS = {
  claude: {
    label: 'Claude',
    appPath: '/Applications/Claude.app',
    appBinary: '/Applications/Claude.app/Contents/MacOS/Claude',
    cli: 'claude',
    defaultHome: path.join(HOME, '.claude'),
    defaultDesktop: path.join(HOME, 'Library', 'Application Support', 'Claude'),
    homeEnv: 'CLAUDE_CONFIG_DIR',
  },
  codex: {
    label: 'Codex',
    appPath: '/Applications/ChatGPT.app',
    appBinary: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
    cli: 'codex',
    defaultHome: path.join(HOME, '.codex'),
    defaultDesktop: path.join(HOME, 'Library', 'Application Support', 'Codex'),
    homeEnv: 'CODEX_HOME',
  },
};

// What can be brought over from one profile to another, per vendor.
//   kind 'paths'       files/folders: linked (kept in sync) or copied once
//   kind 'preferences' the settings file, always copied, with secrets and
//                      connector sections removed
//   kind 'connectors'  MCP servers: always copied, off by default because they
//                      point at one account's Slack, Notion, etc.
// `on` is the default checkbox state in the dialog.
const SETUP_ITEMS = {
  claude: [
    { id: 'preferences', label: 'Preferences', hint: 'Model, permissions, effort level. Never API keys.', kind: 'preferences', on: true },
    { id: 'skills', label: 'Skills', kind: 'paths', paths: ['skills'], on: true },
    { id: 'instructions', label: 'Instructions (CLAUDE.md)', hint: 'Claude edits this file itself, so kept in sync means its edits reach the source profile too.', kind: 'paths', paths: ['CLAUDE.md'], on: true },
    { id: 'agents', label: 'Agents, commands and hooks', kind: 'paths', paths: ['agents', 'commands', 'hooks'], on: true },
    { id: 'keybindings', label: 'Keybindings', kind: 'paths', paths: ['keybindings.json'], on: true },
    { id: 'plugins', label: 'Plugins', hint: 'Plugins can bundle connectors to the source account’s services.', kind: 'paths', paths: ['plugins'], on: false, warn: true },
    { id: 'connectors', label: 'Connectors (MCP servers)', hint: 'These reach the source account’s Slack, Notion, and so on. Usually the new account wants its own.', kind: 'connectors', on: false, warn: true },
    { id: 'history', label: 'Chat history', hint: 'Past Claude Code sessions and the resume list. Always copied once, never linked.', kind: 'paths', paths: ['projects', 'history.jsonl'], copyOnly: true, on: false },
  ],
  codex: [
    { id: 'preferences', label: 'Preferences', hint: 'Model, personality, approval policy, trusted projects.', kind: 'preferences', on: true },
    { id: 'skills', label: 'Skills', kind: 'paths', paths: ['skills'], on: true },
    { id: 'instructions', label: 'Instructions (AGENTS.md) and rules', hint: 'Codex edits these itself, so kept in sync means its edits reach the source profile too.', kind: 'paths', paths: ['AGENTS.md', 'rules'], on: true },
    { id: 'keybindings', label: 'Keybindings', kind: 'paths', paths: ['keybindings.json'], on: true },
    { id: 'plugins', label: 'Plugins and marketplaces', hint: 'Plugins can bundle connectors to the source account’s services.', kind: 'connectors', tables: ['plugins', 'marketplaces'], on: false, warn: true },
    { id: 'connectors', label: 'Connectors (MCP servers)', hint: 'These reach the source account’s Slack, Notion, and so on. Usually the new account wants its own.', kind: 'connectors', tables: ['mcp_servers'], on: false, warn: true },
    { id: 'history', label: 'Chat history', hint: 'Past Codex sessions, the thread list and which project each thread sits in. Always copied once, never linked.', kind: 'paths', paths: ['sessions', 'archived_sessions', 'history.jsonl', 'session_index.jsonl', 'thread_history_*'], copyOnly: true, projectState: true, on: false },
  ],
};

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'profile';
}

function defaults() {
  return {
    settings: { terminal: 'Terminal', pollMinutes: 5, usageMode: 'used' },
    profiles: [
      { id: 'claude-default', vendor: 'claude', name: 'Default', isDefault: true, color: '#d97757' },
      { id: 'codex-default', vendor: 'codex', name: 'Default', isDefault: true, color: '#10a37f' },
    ],
  };
}

function load() {
  let raw = null;
  try {
    raw = fs.readFileSync(STORE, 'utf8');
  } catch {
    // No store yet: first run.
    const d = defaults();
    save(d);
    return d;
  }
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data.profiles)) throw new Error('no profiles array');
    data.settings = { ...defaults().settings, ...(data.settings || {}) };
    return data;
  } catch (e) {
    // The file exists but is unreadable. Keep it: it is the only record of
    // which profiles own which directories, and those directories hold logins.
    const backup = `${STORE}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(STORE, backup);
    } catch {
      /* best effort */
    }
    const d = defaults();
    d.loadError = `Could not read ${STORE} (${e.message}). A copy is at ${backup}; starting with the default profiles.`;
    save(d);
    return d;
  }
}

// Write through a temp file so a crash or a full disk cannot truncate the
// store and lose the mapping from profiles to their directories.
function save(data) {
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  const tmp = `${STORE}.tmp`;
  const { loadError, ...persisted } = data;
  fs.writeFileSync(tmp, JSON.stringify(persisted, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STORE);
}

// Resolved paths for a profile. Default profiles point at the vendor's real
// default locations; everything else lives under ~/.switchboard/<vendor>/<id>/.
function dirs(profile) {
  const v = VENDORS[profile.vendor];
  if (profile.isDefault) {
    return { home: v.defaultHome, desktop: v.defaultDesktop, isDefault: true };
  }
  const base = path.join(ROOT, profile.vendor, profile.id);
  return { home: path.join(base, 'home'), desktop: path.join(base, 'desktop'), isDefault: false };
}

function ensureDirs(profile) {
  const d = dirs(profile);
  if (d.isDefault) return d;
  fs.mkdirSync(d.home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(d.desktop, { recursive: true, mode: 0o700 });
  return d;
}

const PALETTE = ['#d97757', '#10a37f', '#3b82f6', '#a855f7', '#f59e0b', '#ec4899', '#14b8a6', '#64748b'];

// ---- TOML helpers for Codex's config.toml ----
// Split a TOML document into its top-level prefix (keys before any table)
// and a list of {name, text} tables, where name is the first path segment.
function tomlTables(toml) {
  const head = [];
  const tables = [];
  let cur = null;
  for (const line of toml.split('\n')) {
    const m = line.match(/^\s*\[+\s*([^\].\s"]+)/);
    if (m) {
      cur = { name: m[1], lines: [] };
      tables.push(cur);
    }
    (cur ? cur.lines : head).push(line);
  }
  return { head: head.join('\n'), tables: tables.map((t) => ({ name: t.name, text: t.lines.join('\n') })) };
}

// settings.json keys that hold a credential or a command that produces one.
// Never copied into another account's profile.
const CLAUDE_SECRET_KEYS = ['env', 'apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport'];

const CODEX_CONNECTOR_TABLES = ['mcp_servers', 'plugins', 'marketplaces'];

function stripCodexConnectors(toml) {
  const { head, tables } = tomlTables(toml);
  return [head, ...tables.filter((t) => !CODEX_CONNECTOR_TABLES.includes(t.name)).map((t) => t.text)].join('\n').replace(/\n{3,}/g, '\n\n');
}

// Append the named tables from `srcToml` to `dstToml`, replacing any of the
// same name already there.
function mergeCodexTables(dstToml, srcToml, names) {
  const dst = tomlTables(dstToml || '');
  const src = tomlTables(srcToml);
  const kept = dst.tables.filter((t) => !names.includes(t.name));
  const added = src.tables.filter((t) => names.includes(t.name));
  return [dst.head, ...kept.map((t) => t.text), ...added.map((t) => t.text)].join('\n').replace(/\n{3,}/g, '\n\n');
}

// ---- Bringing things over ----
// Codex suffixes its databases with a schema number that changes between
// releases (thread_history_1.sqlite today, state_5.sqlite for another store),
// so those entries are written as a `prefix*` and matched at run time. Every
// other entry is a literal name.
function expandPaths(paths, srcHome) {
  const out = [];
  for (const rel of paths) {
    if (!rel.endsWith('*')) {
      out.push(rel);
      continue;
    }
    const prefix = rel.slice(0, -1);
    let entries = [];
    try {
      entries = fs.readdirSync(srcHome);
    } catch {
      /* source home may not exist yet */
    }
    for (const e of entries) if (e.startsWith(prefix)) out.push(e);
  }
  return out;
}

// Claude Code keeps its per-config-dir state in `.claude.json`. With
// CLAUDE_CONFIG_DIR set that file lives inside the config dir, but the default
// `~/.claude` profile keeps it in the home directory instead.
function claudeJsonPath(home) {
  return home === VENDORS.claude.defaultHome ? path.join(HOME, '.claude.json') : path.join(home, '.claude.json');
}

function isEmptyDir(p) {
  try {
    return fs.statSync(p).isDirectory() && fs.readdirSync(p).length === 0;
  } catch {
    return false;
  }
}

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

// Link or copy one file/folder. Never overwrites content the target already
// has; a folder the vendor pre-populated gets the source's entries merged in.
function bringPath(src, dst, mode, label, out) {
  if (!fs.existsSync(src)) return;
  const st = lstatOrNull(dst);
  if (st && st.isSymbolicLink()) {
    if (fs.readlinkSync(dst) === src) out.done.push(label);
    else out.skipped.push({ item: label, reason: 'already links elsewhere' });
    return;
  }
  if (st && isEmptyDir(dst)) fs.rmdirSync(dst);
  else if (st && st.isDirectory() && fs.statSync(src).isDirectory()) {
    if (mode === 'copy') {
      // Copy anything missing, all the way down, leaving existing files alone.
      const n = mergeCopy(src, dst);
      if (n) out.done.push(`${label} (${n} new)`);
      return;
    }
    for (const child of fs.readdirSync(src)) {
      if (child.startsWith('.')) continue;
      const cs = path.join(src, child);
      const cd = path.join(dst, child);
      if (fs.existsSync(cd)) continue;
      fs.symlinkSync(cs, cd);
      out.done.push(`${label}/${child}`);
    }
    return;
  } else if (st) {
    out.skipped.push({ item: label, reason: 'profile already has its own' });
    return;
  }
  if (mode === 'link') fs.symlinkSync(src, dst);
  else fs.cpSync(src, dst, { recursive: true, dereference: true });
  out.done.push(label);
}

function mergeCopy(src, dst) {
  let n = 0;
  for (const child of fs.readdirSync(src)) {
    if (child.startsWith('.')) continue; // match the link branch
    const cs = path.join(src, child);
    const cd = path.join(dst, child);
    const st = fs.statSync(cs);
    if (st.isDirectory()) {
      fs.mkdirSync(cd, { recursive: true });
      n += mergeCopy(cs, cd);
    } else if (!fs.existsSync(cd)) {
      fs.cpSync(cs, cd, { dereference: true });
      n++;
    }
  }
  return n;
}

function bringPreferences(vendor, srcHome, dstHome, out) {
  if (vendor === 'codex') {
    const src = path.join(srcHome, 'config.toml');
    const dst = path.join(dstHome, 'config.toml');
    if (!fs.existsSync(src)) return;
    if (fs.existsSync(dst)) return out.skipped.push({ item: 'preferences', reason: 'profile already has its own' });
    fs.writeFileSync(dst, stripCodexConnectors(fs.readFileSync(src, 'utf8')));
  } else {
    const src = path.join(srcHome, 'settings.json');
    const dst = path.join(dstHome, 'settings.json');
    if (!fs.existsSync(src)) return;
    if (fs.existsSync(dst)) return out.skipped.push({ item: 'preferences', reason: 'profile already has its own' });
    const s = JSON.parse(fs.readFileSync(src, 'utf8'));
    for (const k of CLAUDE_SECRET_KEYS) delete s[k];
    delete s.enabledPlugins; // plugins are their own item
    delete s.extraKnownMarketplaces;
    fs.writeFileSync(dst, JSON.stringify(s, null, 2));
  }
  out.done.push('preferences');
}

function bringConnectors(vendor, item, srcHome, dstHome, out) {
  if (vendor === 'codex') {
    const src = path.join(srcHome, 'config.toml');
    const dst = path.join(dstHome, 'config.toml');
    if (!fs.existsSync(src)) return;
    const cur = fs.existsSync(dst) ? fs.readFileSync(dst, 'utf8') : '';
    fs.writeFileSync(dst, mergeCodexTables(cur, fs.readFileSync(src, 'utf8'), item.tables));
  } else {
    // Claude Code keeps user-scope MCP servers in .claude.json.
    const src = claudeJsonPath(srcHome);
    const dst = claudeJsonPath(dstHome);
    if (!fs.existsSync(src)) return;
    const servers = JSON.parse(fs.readFileSync(src, 'utf8')).mcpServers || {};
    if (!Object.keys(servers).length) return;
    const cur = fs.existsSync(dst) ? JSON.parse(fs.readFileSync(dst, 'utf8')) : {};
    cur.mcpServers = { ...servers, ...(cur.mcpServers || {}) };
    fs.writeFileSync(dst, JSON.stringify(cur, null, 2));
  }
  out.done.push(item.id);
}

// ---- Codex project grouping ----
// The Codex desktop app keeps its sidebar in <CODEX_HOME>/.codex-global-state.json:
// which folders are projects, which threads belong to which project, and where
// the rest are listed. A thread's rollout does not record its project, and the
// app only places a thread by itself when its working directory is exactly a
// project root, so threads run in worktrees vanish from their project when the
// sessions alone are copied.
//
// Only the keys below are brought over. The same file holds window bounds,
// push tokens, installation ids and per-home migration records, which stay
// with the source. Project ids are random: a project whose root folders the
// target already has (one the user re-added by hand, say) keeps the target's
// id and every reference to it is rewritten; any other project keeps its own.
// The app's database of projects is never touched. Its migration runs per
// home on launch and imports whatever is in `local-projects` but missing there.
const CODEX_GLOBAL_STATE = '.codex-global-state.json';
const CODEX_PROJECT_STATE_KEYS = [
  'local-projects',
  'project-order',
  'project-appearances',
  'sidebar-project-thread-orders',
  'thread-project-assignments',
  'projectless-thread-ids',
  'pinned-thread-ids',
  'thread-workspace-root-hints',
  'thread-projectless-output-directories',
];

// Two projects are the same when they own the same folders. A project with
// no folders matches nothing, so two of those are never folded together.
function sameRoots(a, b) {
  const x = [...(Array.isArray(a) ? a : [])].sort();
  const y = [...(Array.isArray(b) ? b : [])].sort();
  return x.length > 0 && x.length === y.length && x.every((v, i) => v === y[i]);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function bringCodexProjectState(srcHome, dstHome, out) {
  const label = 'project grouping';
  const srcFile = path.join(srcHome, CODEX_GLOBAL_STATE);
  const dstFile = path.join(dstHome, CODEX_GLOBAL_STATE);
  if (!fs.existsSync(srcFile)) return;
  let src;
  let dst;
  try {
    src = readJson(srcFile);
  } catch {
    return out.skipped.push({ item: label, reason: `could not read the source ${CODEX_GLOBAL_STATE}` });
  }
  try {
    dst = fs.existsSync(dstFile) ? readJson(dstFile) : {};
  } catch {
    return out.skipped.push({ item: label, reason: `the profile's ${CODEX_GLOBAL_STATE} is unreadable` });
  }
  if (!src || typeof src !== 'object' || !dst || typeof dst !== 'object') return;
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const arr = (v) => (Array.isArray(v) ? v : []);
  if (!CODEX_PROJECT_STATE_KEYS.some((k) => k in src)) return;

  // Projects, and the map from source ids to the ids the target will use.
  const projects = { ...obj(dst['local-projects']) };
  const idMap = new Map();
  let newProjects = 0;
  for (const [id, p] of Object.entries(obj(src['local-projects']))) {
    if (!p || typeof p !== 'object') continue;
    const existing = Object.values(projects).find((q) => q && sameRoots(q.rootPaths, p.rootPaths));
    if (existing) idMap.set(id, existing.id);
    else if (projects[id]) idMap.set(id, id);
    else {
      projects[id] = { ...p, id };
      idMap.set(id, id);
      newProjects++;
    }
  }
  const remap = (id) => idMap.get(id) || null;

  const order = [...arr(dst['project-order'])];
  for (const id of arr(src['project-order'])) {
    const m = remap(id);
    if (m && projects[m] && !order.includes(m)) order.push(m);
  }

  // Keyed by project id: keep whatever the target has, add the rest remapped.
  const byProject = (key) => {
    const o = { ...obj(dst[key]) };
    for (const [id, v] of Object.entries(obj(src[key]))) {
      const m = remap(id);
      if (m && !(m in o)) o[m] = v;
    }
    return o;
  };

  // Keyed by thread id: an assignment points at a local project via its id.
  const assignments = { ...obj(dst['thread-project-assignments']) };
  let newAssignments = 0;
  for (const [tid, a] of Object.entries(obj(src['thread-project-assignments']))) {
    if (tid in assignments || !a || a.projectKind !== 'local') continue;
    const m = remap(a.projectId);
    if (!m) continue;
    assignments[tid] = { ...a, projectId: m };
    newAssignments++;
  }
  const byThread = (key) => {
    const o = { ...obj(dst[key]) };
    for (const [tid, v] of Object.entries(obj(src[key]))) if (!(tid in o)) o[tid] = v;
    return o;
  };
  const union = (key) => [...new Set([...arr(dst[key]), ...arr(src[key])])];

  const projectless = union('projectless-thread-ids');
  const newProjectless = projectless.length - arr(dst['projectless-thread-ids']).length;
  if (!newProjects && !newAssignments && !newProjectless) {
    return out.skipped.push({ item: label, reason: 'profile already has its own' });
  }
  const next = {
    ...dst,
    'local-projects': projects,
    'project-order': order,
    'project-appearances': byProject('project-appearances'),
    'sidebar-project-thread-orders': byProject('sidebar-project-thread-orders'),
    'thread-project-assignments': assignments,
    'projectless-thread-ids': projectless,
    'pinned-thread-ids': union('pinned-thread-ids'),
    'thread-workspace-root-hints': byThread('thread-workspace-root-hints'),
    'thread-projectless-output-directories': byThread('thread-projectless-output-directories'),
  };
  // Through a temp file, as with the store: a partial write here would make
  // the app discard its whole state file on launch.
  const tmp = `${dstFile}.switchboard-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, dstFile);
  out.done.push(`${label} (${newProjects} projects, ${newAssignments + newProjectless} threads placed)`);
}

// Bring the chosen items from `source` into `profile`.
//   items: array of SETUP_ITEMS ids; mode: 'link' | 'copy'
function bringOver(data, profile, source, { items = [], mode = 'link' } = {}) {
  if (profile.id === source.id) throw new Error('source and target are the same profile');
  if (profile.vendor !== source.vendor) throw new Error('profiles are for different apps');
  if (profile.isDefault) throw new Error('the default profile is never written to');
  const srcHome = dirs(source).home;
  const dstHome = ensureDirs(profile).home;
  const out = { done: [], skipped: [] };
  for (const item of SETUP_ITEMS[profile.vendor]) {
    if (!items.includes(item.id)) continue;
    if (item.kind === 'preferences') bringPreferences(profile.vendor, srcHome, dstHome, out);
    else if (item.kind === 'connectors') bringConnectors(profile.vendor, item, srcHome, dstHome, out);
    else {
      for (const rel of expandPaths(item.paths, srcHome)) bringPath(path.join(srcHome, rel), path.join(dstHome, rel), item.copyOnly ? 'copy' : mode, rel, out);
      if (item.projectState) bringCodexProjectState(srcHome, dstHome, out);
    }
  }
  profile.setup = { from: source.id, items, mode, at: new Date().toISOString() };
  save(data);
  return out;
}

function add(data, { vendor, name, sourceId, items, mode }) {
  if (!VENDORS[vendor]) throw new Error(`unknown vendor ${vendor}`);
  const clean = String(name || '').trim();
  if (!clean) throw new Error('name is required');
  // A directory left behind by an interrupted removal is never adopted by a
  // new profile of the same name: it could still hold another account's login.
  const taken = (i) => data.profiles.some((p) => p.id === i) || fs.existsSync(path.join(ROOT, vendor, i));
  let id = `${vendor}-${slugify(clean)}`;
  let n = 2;
  while (taken(id)) id = `${vendor}-${slugify(clean)}-${n++}`;
  const profile = {
    id,
    vendor,
    name: clean,
    isDefault: false,
    color: PALETTE[data.profiles.length % PALETTE.length],
    createdAt: new Date().toISOString(),
  };
  ensureDirs(profile);
  data.profiles.push(profile);
  save(data);
  const source = sourceId ? data.profiles.find((p) => p.id === sourceId) : null;
  const result = source && items && items.length ? bringOver(data, profile, source, { items, mode }) : { done: [], skipped: [] };
  return { profile, result };
}

// Removing a profile removes everything it owns: its CLI login, desktop
// session, history and settings. There is no keep-the-data variant; the
// directory means nothing without its entry in the store.
function remove(data, id) {
  const p = data.profiles.find((x) => x.id === id);
  if (!p) return;
  if (p.isDefault) throw new Error('the default profile cannot be removed');
  data.profiles = data.profiles.filter((x) => x.id !== id);
  save(data);
  const base = path.join(ROOT, p.vendor, p.id);
  if (base.startsWith(ROOT + path.sep)) fs.rmSync(base, { recursive: true, force: true });
}

function update(data, id, patch) {
  const p = data.profiles.find((x) => x.id === id);
  if (!p) throw new Error('no such profile');
  if (typeof patch.name === 'string' && patch.name.trim()) p.name = patch.name.trim();
  if (typeof patch.color === 'string') p.color = patch.color;
  save(data);
  return p;
}

module.exports = {
  CLAUDE_SECRET_KEYS,
  CODEX_GLOBAL_STATE,
  CODEX_PROJECT_STATE_KEYS,
  VENDORS,
  ROOT,
  SETUP_ITEMS,
  load,
  save,
  dirs,
  ensureDirs,
  add,
  remove,
  update,
  bringOver,
  stripCodexConnectors,
  mergeCodexTables,
  expandPaths,
  claudeJsonPath,
  slugify,
};
