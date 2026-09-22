// Desktop windows: what is running, and starting or stopping a profile's.

import * as launch from '../launch';
import { receipt } from '../buckets/proxy';
import type { Instance, Profile } from '../types';
import type { Context } from './context';
import { parse, required } from './context';
import { confirm, resolveProfile } from './resolve';
import { ref, refused, table } from './output';

export const instances = (): Promise<Instance[]> => launch.runningInstances().catch(() => []);

export const runningPid = (profile: Profile, running: Instance[]): number | null =>
  launch.instanceFor(profile, running)?.pid ?? null;

// The ids of profiles whose window is running.
export async function runningIds(profiles: Profile[]): Promise<Set<string>> {
  const running = await instances();
  return new Set(profiles.filter((p) => runningPid(p, running) !== null).map((p) => p.id));
}

export function assertNotRunning(profile: Profile, running: Instance[], why: string): void {
  if (runningPid(profile, running) !== null) {
    throw refused('desktop-running', `Quit the ${profile.name} window first: ${why}`, `switchboard quit ${profile.id}`);
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Poll until the profile's window is (or is not) running, up to a deadline.
async function waitFor(profile: Profile, present: boolean, ms: number): Promise<number | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const pid = runningPid(profile, await instances());
    if ((pid !== null) === present || Date.now() >= deadline) return pid;
    await delay(250);
  }
}

export async function launchCommand(rest: string[], ctx: Context): Promise<void> {
  const { values, positionals } = parse(rest, { 'no-wait': { type: 'boolean' } });
  const profile = resolveProfile(ctx.data, required(positionals[0], 'Profile'));
  ctx.out.narrate(`Launching ${profile.name}…`);
  await launch.launchDesktop(profile);
  const pid = values['no-wait'] ? null : await waitFor(profile, true, 5_000);
  const port = profile.proxyBucket ? receipt(profile.proxyBucket)?.proxyPort : undefined;
  ctx.out.result({
    profile: ref(profile),
    launched: true,
    running: pid !== null,
    pid,
    ...(profile.proxyBucket && port ? { bucket: { id: profile.proxyBucket, port } } : {}),
  });
}

export async function quitCommand(rest: string[], ctx: Context): Promise<void> {
  const { values, positionals } = parse(rest, { 'no-wait': { type: 'boolean' } });
  const profile = resolveProfile(ctx.data, required(positionals[0], 'Profile'));
  const quit = await launch.quitDesktop(profile);
  const stopped = quit && !values['no-wait'] ? (await waitFor(profile, false, 10_000)) === null : false;
  ctx.out.result({ profile: ref(profile), quit, stopped });
}

export async function quitOthersCommand(rest: string[], ctx: Context): Promise<void> {
  const profile = resolveProfile(ctx.data, required(rest[0], 'Profile'));
  await confirm(ctx.flags, `Quit every other ${profile.vendor} window?`);
  ctx.out.result({ profile: ref(profile), quit: await launch.quitOthers(profile) });
}

export async function runningCommand(_rest: string[], ctx: Context): Promise<void> {
  const running = await instances();
  const rows = running.map((instance) => {
    const owner = ctx.data.profiles.find((p) => launch.instanceFor(p, [instance]));
    return {
      pid: instance.pid,
      vendor: instance.vendor,
      profile: owner ? ref(owner) : null,
      userDataDir: instance.userDataDir,
    };
  });
  ctx.out.result({ instances: rows }, () =>
    table(
      rows.map((r) => ({ pid: r.pid, vendor: r.vendor, profile: r.profile?.id ?? '(unmatched)' })),
      ['pid', 'vendor', 'profile'],
    ),
  );
}

export async function revealCommand(rest: string[], ctx: Context): Promise<void> {
  const profile = resolveProfile(ctx.data, required(rest[0], 'Profile'));
  await launch.revealDir(profile);
  ctx.out.result({ profile: ref(profile), opened: true });
}
