// Every profile's recent sessions, from either app, as one list: the index the
// hub and the CLI read. The vendor readers (claude.ts, codex.ts) turn files
// into the shared model; this decides which files to look at, keeps each
// file's summary until the file changes, and pages transcripts.
//
// `watch` follows the session folders through macOS file events, so the hub
// hears about a change within moments instead of polling. Events say only
// that something changed; the next `list` re-reads what did, by size and
// modification time, and leaves the rest cached.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Vendor } from '../types';
import { byRecent } from './live';
import {
  backgroundCount,
  claudeFiles,
  claudePage,
  scanBackground,
  summarizeClaude,
  STALE_MS,
  type Background,
} from './claude';
import { codexFiles, codexPage, codexThreads, summarizeCodex, type CodexThread } from './codex';
import { stat, type FileInfo } from './jsonl';
import type { SessionSummary, Transcript } from './model';

export type { SessionSummary, Transcript } from './model';
export { STALE_MS } from './claude';

export interface ProfileHome {
  id: string;
  vendor: Vendor;
  home: string;
}

// How far back a session still counts as recent, and how many a profile lists.
export const RECENT_MS = 7 * 24 * 3600_000;
export const PER_PROFILE = 25;

interface Cached {
  mtimeMs: number;
  size: number;
  summary: SessionSummary | null;
  // Claude: background work this file has started, read up to `offset`.
  background?: Background;
}

export class SessionReader {
  private cache = new Map<string, Cached>();
  // Where each listed session's file is: `${profileId}/${sessionId}`.
  private files = new Map<string, { info: FileInfo; thread?: CodexThread }>();

  list(profiles: ProfileHome[], now = Date.now()): SessionSummary[] {
    const all: SessionSummary[] = [];
    const seen = new Set<string>();
    const since = now - RECENT_MS;
    for (const profile of profiles) {
      const candidates: { info: FileInfo; thread?: CodexThread }[] =
        profile.vendor === 'claude'
          ? claudeFiles(profile.home, since).map((info) => ({ info }))
          : codexThreads(profile.home, since, PER_PROFILE).map((thread) => ({ info: thread.info, thread }));
      candidates.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
      let count = 0;
      for (const c of candidates) {
        if (count >= PER_PROFILE) break;
        seen.add(c.info.file);
        let cached = this.cache.get(c.info.file);
        const changed = !cached || cached.mtimeMs !== c.info.mtimeMs || cached.size !== c.info.size;
        let bg = cached?.background;
        let running = 0;
        if (!c.thread) {
          try {
            if (changed || !bg) bg = scanBackground(c.info, bg);
            running = backgroundCount(c.info, bg, now);
          } catch {
            bg = undefined;
          }
        }
        // Background work can finish or go quiet without the file changing,
        // and a waiting session's scheduled time can pass.
        if (
          changed ||
          !cached ||
          (cached.summary && (cached.summary.background !== running || cached.summary.state === 'waiting'))
        ) {
          let summary: SessionSummary | null = null;
          try {
            summary = c.thread
              ? summarizeCodex(profile.id, c.thread, now)
              : summarizeClaude(profile.id, c.info, now, running);
          } catch {
            summary = null;
          }
          cached = { mtimeMs: c.info.mtimeMs, size: c.info.size, summary, background: bg };
          this.cache.set(c.info.file, cached);
        } else if (cached.summary) {
          // Unchanged file, but time has passed: a stale turn stops working,
          // and a Codex rename lands without touching the rollout.
          let s = cached.summary;
          if (s.state === 'working' && !s.background && now - c.info.mtimeMs >= STALE_MS)
            s = { ...s, state: 'finished' };
          if (c.thread?.title && c.thread.title !== s.title) s = { ...s, title: c.thread.title };
          cached.summary = s;
        }
        if (!cached.summary) continue;
        this.files.set(`${profile.id}/${cached.summary.id}`, c);
        all.push(cached.summary);
        count++;
      }
    }
    for (const file of this.cache.keys()) if (!seen.has(file)) this.cache.delete(file);
    return all.sort(byRecent);
  }

  // One page of a session's transcript, newest page first; pass the returned
  // `before` back for the page before it.
  transcript(
    profiles: ProfileHome[],
    profileId: string,
    sessionId: string,
    before: number | null = null,
    now = Date.now(),
  ): Transcript | null {
    const key = `${profileId}/${sessionId}`;
    if (!this.files.has(key))
      this.list(
        profiles.filter((p) => p.id === profileId),
        now,
      );
    const known = this.files.get(key);
    const info = known && stat(known.info.file);
    if (!known || !info) return null;
    const running = this.cache.get(info.file)?.summary?.background ?? 0;
    const session = known.thread
      ? summarizeCodex(profileId, { ...known.thread, info }, now)
      : summarizeClaude(profileId, info, now, running);
    if (!session) return null;
    const page = known.thread ? codexPage(info, before) : claudePage(info, before);
    const home = profiles.find((p) => p.id === profileId)?.home;
    const files = known.thread && home && before === null ? codexFiles(home, sessionId) : [];
    return { session, entries: page.entries, before: page.before, files };
  }
}

// Calls `onChange` (debounced) when anything under a profile's session
// folders changes. Returns a function that stops watching.
export function watch(profiles: ProfileHome[], onChange: () => void, debounceMs = 300): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, debounceMs);
  };
  const watchers: fs.FSWatcher[] = [];
  for (const p of profiles) {
    // Codex's home itself is watched shallowly, for its thread index.
    const dirs: [string, boolean][] =
      p.vendor === 'claude'
        ? [[path.join(p.home, 'projects'), true]]
        : [
            [path.join(p.home, 'sessions'), true],
            [p.home, false],
          ];
    for (const [dir, recursive] of dirs) {
      try {
        watchers.push(fs.watch(dir, { recursive, persistent: false }, fire));
      } catch {
        // Not created yet; the hub's fallback timer covers it.
      }
    }
  }
  return () => {
    if (timer) clearTimeout(timer);
    for (const w of watchers) w.close();
  };
}
