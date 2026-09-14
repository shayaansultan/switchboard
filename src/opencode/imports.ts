import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse, type ParseError } from 'jsonc-parser';
import { ObjectValue, type ImportMode, unreachable } from './types';
import { paths, load, writeJson } from './profiles';

type FileItem = { kind: 'skill' | 'instructions' | 'keybindings'; name: string; source: string };
type PreferenceItem = { kind: 'preferences'; name: 'preferences'; source: string };
type PluginItem = { kind: 'plugin'; name: string; source: string; specifier: string };
type McpItem = { kind: 'mcp'; name: string; source: string; definition: ObjectValue };
export type ImportItem = FileItem | PreferenceItem | PluginItem | McpItem;

export function config(file: string): ObjectValue {
  const errors: ParseError[] = [];
  const value: unknown = parse(fs.readFileSync(file, 'utf8'), errors, { allowTrailingComma: true });
  if (errors.length) throw new Error(`Invalid JSON/JSONC: ${file}`);
  return ObjectValue.parse(value);
}
export function scan(source: string): ImportItem[] {
  const base = path.resolve(source);
  const items: ImportItem[] = [];
  const skillRoot = path.join(base, 'skills');
  if (fs.existsSync(skillRoot)) {
    for (const name of fs.readdirSync(skillRoot)) {
      const directory = path.join(skillRoot, name);
      if (fs.existsSync(path.join(directory, 'SKILL.md'))) items.push({ kind: 'skill', name, source: directory });
    }
  }
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const file = path.join(base, name);
    if (fs.existsSync(file)) items.push({ kind: 'instructions', name, source: file });
  }
  const tui = ['tui.jsonc', 'tui.json'].map((name) => path.join(base, name)).find((file) => fs.existsSync(file));
  if (tui) items.push({ kind: 'keybindings', name: 'tui.json', source: tui });
  const file = ['opencode.jsonc', 'opencode.json']
    .map((name) => path.join(base, name))
    .find((candidate) => fs.existsSync(candidate));
  if (file) {
    const settings = config(file);
    items.push({ kind: 'preferences', name: 'preferences', source: file });
    if (Array.isArray(settings.plugin)) {
      for (const specifier of settings.plugin) {
        if (typeof specifier === 'string') items.push({ kind: 'plugin', name: specifier, source: file, specifier });
      }
    }
    const mcp = ObjectValue.safeParse(settings.mcp);
    if (mcp.success) {
      for (const [name, value] of Object.entries(mcp.data)) {
        items.push({ kind: 'mcp', name, source: file, definition: ObjectValue.parse(value) });
      }
    }
  }
  return items;
}
function copyFileItem(id: string, item: FileItem, mode: ImportMode): void {
  if (path.basename(item.name) !== item.name || item.name.startsWith('.')) throw new Error('Invalid import name');
  const directory = paths(id).config;
  let destination: string;
  switch (item.kind) {
    case 'skill':
      destination = path.join(directory, 'skills', item.name);
      break;
    case 'instructions':
      destination = path.join(directory, 'AGENTS.md');
      break;
    case 'keybindings':
      destination = path.join(directory, 'tui.json');
      break;
    default:
      return unreachable(item.kind);
  }
  let present = false;
  try {
    fs.lstatSync(destination);
    present = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (present) throw new Error(`Already exists: ${destination}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  switch (mode) {
    case 'copy':
      fs.cpSync(item.source, destination, { recursive: true, dereference: true, force: false, errorOnExist: true });
      break;
    case 'link':
      fs.symlinkSync(path.resolve(item.source), destination);
      break;
    default:
      unreachable(mode);
  }
}
export function apply(id: string, item: ImportItem, mode: ImportMode): void {
  load(id);
  switch (item.kind) {
    case 'skill':
    case 'instructions':
    case 'keybindings':
      copyFileItem(id, item, mode);
      break;
    case 'preferences':
    case 'plugin':
    case 'mcp': {
      if (mode !== 'copy') throw new Error('Only files and skills support linking');
      const file = path.join(paths(id).config, 'opencode.json');
      const settings = config(file);
      switch (item.kind) {
        case 'preferences': {
          const source = config(item.source);
          // No provider credentials, model overrides or executable configuration.
          for (const key of ['permission', 'compaction', 'snapshot', 'share']) {
            if (source[key] !== undefined && settings[key] === undefined) settings[key] = source[key];
          }
          break;
        }
        case 'plugin': {
          const specifier = item.specifier.startsWith('.')
            ? path.resolve(path.dirname(item.source), item.specifier)
            : item.specifier;
          settings.plugin = [...new Set([...(Array.isArray(settings.plugin) ? settings.plugin : []), specifier])];
          break;
        }
        case 'mcp': {
          // Copy only a remote endpoint, disabled. Arbitrary command arguments,
          // headers and even secret-file references can carry another identity.
          if (item.definition.type !== 'remote' || typeof item.definition.url !== 'string')
            throw new Error('Configure local MCP commands explicitly; they can embed credentials');
          const url = new URL(item.definition.url);
          if (url.username || url.password || url.search || /\{(?:env|file):/.test(url.href))
            throw new Error('Endpoint contains credentials or substitutions; configure it explicitly');
          const current = settings.mcp === undefined ? {} : ObjectValue.parse(settings.mcp);
          if (current[item.name]) throw new Error(`MCP already exists: ${item.name}`);
          settings.mcp = { ...current, [item.name]: { type: 'remote', url: url.href, enabled: false } };
          break;
        }
        default:
          unreachable(item);
      }
      writeJson(file, settings);
      break;
    }
    default:
      unreachable(item);
  }
}
