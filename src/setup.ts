// Bringing skills, settings, connectors and history from one profile into
// another. Nothing here ever writes into a Default profile, and logins are
// never brought over: see bringPreferences and the notes on each item.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { HOME, VENDORS, dirs, ensureDirs, save, create } from './store';
import type { AddOptions, BringMode, BringOptions, BringResult, Profile, SetupItem, Store, Vendor } from './types';

// What can be brought over from one profile to another, per vendor.
//   kind 'paths'       files/folders: linked (kept in sync) or copied once
//   kind 'preferences' the settings file, always copied, with secrets and
//                      connector sections removed
//   kind 'connectors'  MCP servers: always copied, off by default because they
//                      point at one account's Slack, Notion, etc.
// `on` is the default checkbox state in the dialog.
export const SETUP_ITEMS: Record<Vendor, SetupItem[]> = {
  claude: [
    {
      id: 'preferences',
      label: 'Preferences',
      hint: 'Model, permissions, effort level. Never API keys.',
      kind: 'preferences',
      on: true,
    },
    { id: 'skills', label: 'Skills', kind: 'paths', paths: ['skills'], on: true },
    {
      id: 'instructions',
      label: 'Instructions (CLAUDE.md)',
      hint: 'Claude edits this file itself, so kept in sync means its edits reach the source profile too.',
      kind: 'paths',
      paths: ['CLAUDE.md'],
      on: true,
    },
    {
      id: 'agents',
      label: 'Agents, commands and hooks',
      kind: 'paths',
      paths: ['agents', 'commands', 'hooks'],
      on: true,
    },
    { id: 'keybindings', label: 'Keybindings', kind: 'paths', paths: ['keybindings.json'], on: true },
    {
      id: 'plugins',
      label: 'Plugins',
      hint: 'Plugins can bundle connectors to the source account’s services.',
      kind: 'paths',
      paths: ['plugins'],
      on: false,
      warn: true,
    },
    {
      id: 'connectors',
      label: 'Connectors (MCP servers)',
      hint: 'These reach the source account’s Slack, Notion, and so on. Usually the new account wants its own.',
      kind: 'connectors',
      on: false,
      warn: true,
    },
    {
      id: 'history',
      label: 'Chat history',
      hint: 'Past Claude Code sessions and the resume list. Always copied once, never linked.',
      kind: 'paths',
      paths: ['projects', 'history.jsonl'],
      copyOnly: true,
      on: false,
    },
  ],
  codex: [
    {
      id: 'preferences',
      label: 'Preferences',
      hint: 'Model, personality, approval policy, trusted projects.',
      kind: 'preferences',
      on: true,
    },
    { id: 'skills', label: 'Skills', kind: 'paths', paths: ['skills'], on: true },
    {
      id: 'instructions',
      label: 'Instructions (AGENTS.md) and rules',
      hint: 'Codex edits these itself, so kept in sync means its edits reach the source profile too.',
      kind: 'paths',
      paths: ['AGENTS.md', 'rules'],
      on: true,
    },
    { id: 'keybindings', label: 'Keybindings', kind: 'paths', paths: ['keybindings.json'], on: true },
    {
      id: 'plugins',
      label: 'Plugins and marketplaces',
      hint: 'Plugins can bundle connectors to the source account’s services.',
      kind: 'connectors',
      tables: ['plugins', 'marketplaces'],
      on: false,
      warn: true,
    },
    {
      id: 'connectors',
      label: 'Connectors (MCP servers)',
      hint: 'These reach the source account’s Slack, Notion, and so on. Usually the new account wants its own.',
      kind: 'connectors',
      tables: ['mcp_servers'],
      on: false,
      warn: true,
    },
    {
      id: 'history',
      label: 'Chat history',
      hint: 'Past Codex sessions, the thread list and which project each thread sits in. Always copied once, never linked.',
      kind: 'paths',
      paths: ['sessions', 'archived_sessions', 'history.jsonl', 'session_index.jsonl', 'thread_history_*'],
      copyOnly: true,
      projectState: true,
      on: false,
    },
  ],
};

// ---- TOML helpers for Codex's config.toml ----
// Split a TOML document into its top-level prefix (keys before any table)
// and a list of {name, text} tables, where name is the first path segment.
function tomlTables(toml: string): { head: string; tables: { name: string; text: string }[] } {
  const head: string[] = [];
  const tables: { name: string; lines: string[] }[] = [];
  let cur: { name: string; lines: string[] } | null = null;
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
export const CLAUDE_SECRET_KEYS = ['env', 'apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport'];

const CODEX_CONNECTOR_TABLES = ['mcp_servers', 'plugins', 'marketplaces'];

export function stripCodexConnectors(toml: string): string {
  const { head, tables } = tomlTables(toml);
  return [head, ...tables.filter((t) => !CODEX_CONNECTOR_TABLES.includes(t.name)).map((t) => t.text)]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

// Append the named tables from `srcToml` to `dstToml`, replacing any of the
// same name already there.
export function mergeCodexTables(dstToml: string, srcToml: string, names: string[]): string {
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
export function expandPaths(paths: string[], srcHome: string): string[] {
  const out: string[] = [];
  for (const rel of paths) {
    if (!rel.endsWith('*')) {
      out.push(rel);
      continue;
    }
    const prefix = rel.slice(0, -1);
    let entries: string[] = [];
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
export function claudeJsonPath(home: string): string {
  return home === VENDORS.claude.defaultHome ? path.join(HOME, '.claude.json') : path.join(home, '.claude.json');
}

function isEmptyDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory() && fs.readdirSync(p).length === 0;
  } catch {
    return false;
  }
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

// Link or copy one file/folder. Never overwrites content the target already
// has; a folder the vendor pre-populated gets the source's entries merged in.
function bringPath(src: string, dst: string, mode: BringMode, label: string, out: BringResult): void {
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

function mergeCopy(src: string, dst: string): number {
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

function bringPreferences(vendor: Vendor, srcHome: string, dstHome: string, out: BringResult): void {
  if (vendor === 'codex') {
    const src = path.join(srcHome, 'config.toml');
    const dst = path.join(dstHome, 'config.toml');
    if (!fs.existsSync(src)) return;
    if (fs.existsSync(dst)) {
      out.skipped.push({ item: 'preferences', reason: 'profile already has its own' });
      return;
    }
    fs.writeFileSync(dst, stripCodexConnectors(fs.readFileSync(src, 'utf8')));
  } else {
    const src = path.join(srcHome, 'settings.json');
    const dst = path.join(dstHome, 'settings.json');
    if (!fs.existsSync(src)) return;
    if (fs.existsSync(dst)) {
      out.skipped.push({ item: 'preferences', reason: 'profile already has its own' });
      return;
    }
    const s = JSON.parse(fs.readFileSync(src, 'utf8')) as Record<string, unknown>;
    for (const k of CLAUDE_SECRET_KEYS) delete s[k];
    delete s.enabledPlugins; // plugins are their own item
    delete s.extraKnownMarketplaces;
    fs.writeFileSync(dst, JSON.stringify(s, null, 2));
  }
  out.done.push('preferences');
}

function bringConnectors(vendor: Vendor, item: SetupItem, srcHome: string, dstHome: string, out: BringResult): void {
  if (vendor === 'codex') {
    const src = path.join(srcHome, 'config.toml');
    const dst = path.join(dstHome, 'config.toml');
    if (!fs.existsSync(src)) return;
    const cur = fs.existsSync(dst) ? fs.readFileSync(dst, 'utf8') : '';
    fs.writeFileSync(dst, mergeCodexTables(cur, fs.readFileSync(src, 'utf8'), item.tables ?? []));
  } else {
    // Claude Code keeps user-scope MCP servers in .claude.json.
    const src = claudeJsonPath(srcHome);
    const dst = claudeJsonPath(dstHome);
    if (!fs.existsSync(src)) return;
    const servers = (JSON.parse(fs.readFileSync(src, 'utf8')).mcpServers || {}) as Record<string, unknown>;
    if (!Object.keys(servers).length) return;
    const cur = (fs.existsSync(dst) ? JSON.parse(fs.readFileSync(dst, 'utf8')) : {}) as {
      mcpServers?: Record<string, unknown>;
    };
    cur.mcpServers = { ...servers, ...cur.mcpServers };
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
export const CODEX_GLOBAL_STATE = '.codex-global-state.json';
export const CODEX_PROJECT_STATE_KEYS = [
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

// The file is the app's, so its contents are taken as loosely as they come.
type Loose = Record<string, unknown>;
interface LocalProject extends Loose {
  id: string;
  rootPaths?: unknown;
}
interface Assignment extends Loose {
  projectKind?: string;
  projectId?: string;
}

// Two projects are the same when they own the same folders. A project with
// no folders matches nothing, so two of those are never folded together.
function sameRoots(a: unknown, b: unknown): boolean {
  const x = [...(Array.isArray(a) ? (a as string[]) : [])].sort();
  const y = [...(Array.isArray(b) ? (b as string[]) : [])].sort();
  return x.length > 0 && x.length === y.length && x.every((v, i) => v === y[i]);
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isRecord(v: unknown): v is Loose {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function bringCodexProjectState(srcHome: string, dstHome: string, out: BringResult): void {
  const label = 'project grouping';
  const srcFile = path.join(srcHome, CODEX_GLOBAL_STATE);
  const dstFile = path.join(dstHome, CODEX_GLOBAL_STATE);
  if (!fs.existsSync(srcFile)) return;
  let srcRaw: unknown;
  let dstRaw: unknown;
  try {
    srcRaw = readJson(srcFile);
  } catch {
    out.skipped.push({ item: label, reason: `could not read the source ${CODEX_GLOBAL_STATE}` });
    return;
  }
  try {
    dstRaw = fs.existsSync(dstFile) ? readJson(dstFile) : {};
  } catch {
    out.skipped.push({ item: label, reason: `the profile's ${CODEX_GLOBAL_STATE} is unreadable` });
    return;
  }
  if (!isRecord(srcRaw) || !isRecord(dstRaw)) return;
  const src = srcRaw;
  const dst = dstRaw;
  const obj = (v: unknown): Loose => (isRecord(v) ? v : {});
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  if (!CODEX_PROJECT_STATE_KEYS.some((k) => k in src)) return;

  // Projects, and the map from source ids to the ids the target will use.
  const projects: Record<string, LocalProject> = { ...(obj(dst['local-projects']) as Record<string, LocalProject>) };
  const idMap = new Map<string, string>();
  let newProjects = 0;
  for (const [id, p] of Object.entries(obj(src['local-projects']))) {
    if (!isRecord(p)) continue;
    const existing = Object.values(projects).find((q) => q && sameRoots(q.rootPaths, p.rootPaths));
    if (existing) idMap.set(id, existing.id);
    else if (projects[id]) idMap.set(id, id);
    else {
      projects[id] = { ...p, id };
      idMap.set(id, id);
      newProjects++;
    }
  }
  const remap = (id: unknown): string | null => (typeof id === 'string' && idMap.get(id)) || null;

  const order = [...arr(dst['project-order'])];
  for (const id of arr(src['project-order'])) {
    const m = remap(id);
    if (m && projects[m] && !order.includes(m)) order.push(m);
  }

  // Keyed by project id: keep whatever the target has, add the rest remapped.
  const byProject = (key: string): Loose => {
    const o: Loose = { ...obj(dst[key]) };
    for (const [id, v] of Object.entries(obj(src[key]))) {
      const m = remap(id);
      if (m && !(m in o)) o[m] = v;
    }
    return o;
  };

  // Keyed by thread id: an assignment points at a local project via its id.
  const assignments: Record<string, Assignment> = {
    ...(obj(dst['thread-project-assignments']) as Record<string, Assignment>),
  };
  let newAssignments = 0;
  for (const [tid, a] of Object.entries(obj(src['thread-project-assignments']))) {
    if (tid in assignments || !isRecord(a) || a.projectKind !== 'local') continue;
    const m = remap(a.projectId);
    if (!m) continue;
    assignments[tid] = { ...a, projectId: m };
    newAssignments++;
  }
  const byThread = (key: string): Loose => {
    const o: Loose = { ...obj(dst[key]) };
    for (const [tid, v] of Object.entries(obj(src[key]))) if (!(tid in o)) o[tid] = v;
    return o;
  };
  const union = (key: string): unknown[] => [...new Set([...arr(dst[key]), ...arr(src[key])])];

  const projectless = union('projectless-thread-ids');
  const newProjectless = projectless.length - arr(dst['projectless-thread-ids']).length;
  if (!newProjects && !newAssignments && !newProjectless) {
    out.skipped.push({ item: label, reason: 'profile already has its own' });
    return;
  }
  const next: Loose = {
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
export function bringOver(
  data: Store,
  profile: Profile,
  source: Profile,
  { items = [], mode = 'link' }: BringOptions = {},
): BringResult {
  if (profile.id === source.id) throw new Error('source and target are the same profile');
  if (profile.vendor !== source.vendor) throw new Error('profiles are for different apps');
  if (profile.isDefault) throw new Error('the default profile is never written to');
  const srcHome = dirs(source).home;
  const dstHome = ensureDirs(profile).home;
  const out: BringResult = { done: [], skipped: [] };
  for (const item of SETUP_ITEMS[profile.vendor]) {
    if (!items.includes(item.id)) continue;
    if (item.kind === 'preferences') bringPreferences(profile.vendor, srcHome, dstHome, out);
    else if (item.kind === 'connectors') bringConnectors(profile.vendor, item, srcHome, dstHome, out);
    else {
      for (const rel of expandPaths(item.paths ?? [], srcHome))
        bringPath(path.join(srcHome, rel), path.join(dstHome, rel), item.copyOnly ? 'copy' : mode, rel, out);
      if (item.projectState) bringCodexProjectState(srcHome, dstHome, out);
    }
  }
  profile.setup = { from: source.id, items, mode, at: new Date().toISOString() };
  save(data);
  return out;
}

export function add(
  data: Store,
  { vendor, name, sourceId, items, mode }: AddOptions,
): { profile: Profile; result: BringResult } {
  const profile = create(data, { vendor, name });
  const source = sourceId ? data.profiles.find((p) => p.id === sourceId) : null;
  const result =
    source && items && items.length ? bringOver(data, profile, source, { items, mode }) : { done: [], skipped: [] };
  return { profile, result };
}
