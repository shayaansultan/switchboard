// `switchboard remote`: phone access from a terminal. The same operations the
// window's Phone access section uses: turn it on or off (the phoneAccess
// setting, which the app follows), make a pairing code, list and unpair
// phones, and read what the phone would see, sessions and transcripts.
//
// The hub itself runs in the app. This command never starts a server; it
// reads the app's hub.json and checks the port before reporting it running.

import { dirs, save } from '../store';
import { DEFAULT_PORT } from '../remote/hub';
import { listDevices, revoke } from '../remote/pairing';
import { SessionReader } from '../remote/sessions';
import { pairing, phoneStatus, serveCommand } from '../remote/status';
import type { Context } from './context';
import { parse, required } from './context';
import { notFound, refused, usageError } from './output';
import { mutateStore, resolveProfile } from './resolve';

const SUBCOMMANDS = 'status, on, off, pair, devices, unpair, sessions, session';

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
      ctx.out.result(await phoneStatus(ctx.data.settings));
      return;
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
      const profile = resolveProfile(ctx.data, required(args[0], 'Profile'));
      const id = required(args[1], 'Session id');
      const transcript = new SessionReader().transcript(homes(ctx), profile.id, id);
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
