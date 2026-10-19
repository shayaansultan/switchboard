// `switchboard remote`: phone access from a terminal. The same operations the
// window's Phone access section uses: turn it on or off (the phoneAccess
// setting, which the app follows), make a pairing code, list and unpair
// phones, choose what each phone is notified about, and read what the phone
// would see, sessions and transcripts. A phone turns notifications on itself:
// only it can make the subscription.
//
// The hub itself runs in the app. This command never starts a server; it
// reads the app's hub.json and checks the port before reporting it running.

import { dirs, save } from '../store';
import { DEFAULT_PORT } from '../remote/hub';
import * as launch from '../launch';
import { listDevices, revoke } from '../remote/pairing';
import { NoteKind, push, pushState, setPrefs, unsubscribe } from '../remote/push';
import { SessionReader } from '../remote/sessions';
import { pairing, phoneStatus, publish, serveCommand } from '../remote/status';
import type { Context } from './context';
import { parse, required } from './context';
import { notFound, refused, usageError } from './output';
import { mutateStore, resolveProfile } from './resolve';

const SUBCOMMANDS = 'status, on, off, publish, pair, devices, unpair, notifications, relaunch, sessions, session';

function homes(ctx: Context) {
  return ctx.data.profiles.map((p) => ({ id: p.id, vendor: p.vendor, home: dirs(p).home }));
}

function setEnabled(enabled: boolean, port: number | undefined) {
  return mutateStore((data) => {
    data.settings = { ...data.settings, phoneAccess: enabled, ...(port ? { phonePort: port } : {}) };
    save(data);
    return { phoneAccess: data.settings.phoneAccess, phonePort: data.settings.phonePort ?? DEFAULT_PORT };
  });
}

export async function remoteCommand(rest: string[], ctx: Context): Promise<void> {
  const [sub, ...args] = rest;
  switch (sub) {
    case 'status':
    case undefined:
      ctx.out.result(await phoneStatus(ctx.data.settings, ctx.data.profiles));
      return;
    case 'publish': {
      // `tailscale serve` for the hub, as the Phone tab's Publish button runs it.
      if (!ctx.data.settings.phoneAccess)
        throw refused('phone-access-off', 'Phone access is off', 'switchboard remote on');
      const result = await publish(ctx.data.settings.phonePort ?? DEFAULT_PORT);
      if (result.enableUrl)
        throw refused(
          'serve-not-allowed',
          `Tailscale wants Serve or HTTPS allowed on your tailnet first: open ${result.enableUrl}, then publish again`,
        );
      if (!result.published) throw refused('publish-failed', result.error ?? 'tailscale serve failed');
      ctx.out.result({ published: true, serve: serveCommand(ctx.data.settings.phonePort ?? DEFAULT_PORT) });
      return;
    }
    case 'on': {
      const { values } = parse(args, { port: { type: 'string' } });
      const port = values.port === undefined ? undefined : Number(values.port);
      if (port !== undefined && (!Number.isInteger(port) || port < 1024 || port > 65535))
        throw usageError('--port must be a port from 1024 to 65535');
      const settings = setEnabled(true, port);
      ctx.out.narrate(`Publish it on your tailnet once with: ${serveCommand(settings.phonePort)}`);
      ctx.out.result(settings);
      return;
    }
    case 'off':
      ctx.out.result(setEnabled(false, undefined));
      return;
    case 'pair': {
      if (!ctx.data.settings.phoneAccess)
        throw refused('phone-access-off', 'Phone access is off', 'switchboard remote on');
      ctx.out.result(await pairing());
      return;
    }
    case 'devices':
      ctx.out.result({ devices: listDevices() });
      return;
    case 'unpair': {
      const { values, positionals } = parse(args, { all: { type: 'boolean' } });
      if (values.all) {
        if (!ctx.flags.yes)
          throw refused('needs-yes', 'Unpairing every phone needs --yes', 'switchboard remote unpair --all --yes');
        ctx.out.result({ unpaired: revoke('all') });
        return;
      }
      const id = required(positionals[0], 'Device id');
      const gone = revoke(id);
      if (!gone.length) throw notFound('no-such-device', `No paired device ${id}`, 'switchboard remote devices');
      ctx.out.result({ unpaired: gone });
      return;
    }
    case 'notifications': {
      const { values, positionals } = parse(args, {
        kinds: { type: 'string' },
        sessions: { type: 'string' },
        off: { type: 'boolean' },
        test: { type: 'boolean' },
      });
      const devices = listDevices();
      const view = (d: (typeof devices)[number]) => {
        const state = pushState(d.id);
        return {
          id: d.id,
          name: d.name,
          on: state.on,
          kinds: NoteKind.options.filter((k) => state.prefs[k]),
          // Desktop sessions only, or terminal, IDE and scripted runs too.
          sessions: state.prefs.allSessions ? 'all' : 'desktop',
        };
      };
      if (!positionals[0]) {
        if (values.kinds || values.sessions || values.off || values.test)
          throw usageError('Name the phone: switchboard remote notifications DEVICE_ID ...');
        ctx.out.result({ phones: devices.map(view) });
        return;
      }
      const device = devices.find((d) => d.id === positionals[0]);
      if (!device) throw notFound('no-such-device', `No paired device ${positionals[0]}`, 'switchboard remote devices');
      if (values.off) unsubscribe(device.id);
      else if (values.kinds !== undefined || values.sessions !== undefined || values.test) {
        if (!pushState(device.id).on)
          throw refused('not-on', 'Notifications are off on that phone; turn them on in its Settings first');
        if (values.kinds !== undefined) {
          const asked = values.kinds
            .split(',')
            .map((k) => k.trim())
            .filter(Boolean);
          const bad = asked.filter((k) => !NoteKind.options.includes(k as NoteKind));
          if (bad.length) throw usageError(`Unknown kinds: ${bad.join(', ')}. Kinds: ${NoteKind.options.join(', ')}`);
          setPrefs(device.id, {
            ...pushState(device.id).prefs,
            ...(Object.fromEntries(NoteKind.options.map((k) => [k, asked.includes(k)])) as Record<NoteKind, boolean>),
          });
        }
        if (values.sessions !== undefined) {
          if (values.sessions !== 'desktop' && values.sessions !== 'all')
            throw usageError('--sessions must be desktop or all');
          setPrefs(device.id, { ...pushState(device.id).prefs, allSessions: values.sessions === 'all' });
        }
        if (values.test) {
          const sent = await push(
            { kind: 'needs', title: 'Switchboard', body: 'A test from this Mac.', tag: 'test', url: '#/settings' },
            { deviceId: device.id },
          );
          ctx.out.result({ ...view(device), sent: sent > 0 });
          return;
        }
      }
      ctx.out.result(view(device));
      return;
    }
    case 'relaunch': {
      // Quit a profile's app and open it again with the phone's hook: for one
      // opened from the Dock or before phone access was on. Anything it is
      // running stops, so this is the user's to ask for.
      const profile = resolveProfile(ctx.data, required(args[0], 'Profile'));
      if (!ctx.data.settings.phoneAccess)
        throw refused('phone-access-off', 'Phone access is off', 'switchboard remote on');
      try {
        await launch.relaunchForPhone(profile);
      } catch (error) {
        if ((error as { code?: string }).code === 'did-not-quit')
          throw refused('did-not-quit', (error as Error).message);
        throw error;
      }
      ctx.out.result({ profile: profile.id, relaunched: true });
      return;
    }
    case 'sessions': {
      const { values, positionals } = parse(args, { all: { type: 'boolean' }, working: { type: 'boolean' } });
      const wanted = positionals.length ? new Set(positionals.map((t) => resolveProfile(ctx.data, t).id)) : null;
      const sessions = new SessionReader()
        .list(homes(ctx).filter((h) => !wanted || wanted.has(h.id)))
        .filter((s) => values.all || s.origin === 'desktop')
        .filter((s) => !values.working || s.state === 'working');
      if (ctx.flags.human) {
        for (const s of sessions)
          ctx.out.text(
            `${s.state === 'working' ? '●' : ' '} ${s.profileId.padEnd(18)} ${s.updatedAt.slice(0, 16)}  ${s.title}`,
          );
        return;
      }
      ctx.out.result({ sessions });
      return;
    }
    case 'session': {
      const { values, positionals } = parse(args, { before: { type: 'string' } });
      const profile = resolveProfile(ctx.data, required(positionals[0], 'Profile'));
      const id = required(positionals[1], 'Session id');
      const before = values.before === undefined ? null : Number(values.before);
      if (before !== null && (!Number.isInteger(before) || before <= 0))
        throw usageError('--before must be a byte position from an earlier page');
      const transcript = new SessionReader().transcript(homes(ctx), profile.id, id, before);
      if (!transcript)
        throw notFound(
          'no-such-session',
          `No recent session ${id} in ${profile.id}`,
          'switchboard remote sessions --all',
        );
      ctx.out.result(transcript);
      return;
    }
    default:
      throw usageError(`remote needs one of: ${SUBCOMMANDS}`);
  }
}
