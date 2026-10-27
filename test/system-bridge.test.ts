// The bridge client against stand-in bridges: shell scripts that answer one
// request or exit, so no helper or signing is involved.
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSystemBridge, type BridgeReply } from '../src/system-bridge';

const darwin = process.platform === 'darwin';

function script(body: string): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-')), 'bridge');
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

test.if(darwin)(
  'a bridge that dies after answering tells the controllers; close() and a bridge that never answered do not',
  async () => {
    const events: BridgeReply[] = [];
    // Answers one request, then dies, as a crashed bridge would.
    // Echoes the request's id, so a restarted bridge answers its own request.
    const answer =
      'read line; id=$(echo "$line" | sed -E \'s/.*"id":([0-9]+).*/\\1/\'); echo "{\\"id\\":$id,\\"ok\\":true}"';
    const dying = spawnSystemBridge(script(`${answer}; sleep 0.2; exit 1`))!;
    dying.onEvent((event) => events.push(event));
    expect(await dying.request({ op: 'state' })).toMatchObject({ ok: true });
    await Bun.sleep(600);
    expect(events).toEqual([{ event: 'helper-lost' }]);
    // A second crash soon after is reported once five seconds have passed.
    expect(await dying.request({ op: 'state' })).toMatchObject({ ok: true });
    await Bun.sleep(600);
    expect(events).toHaveLength(1);
    await Bun.sleep(4_200);
    expect(events).toEqual([{ event: 'helper-lost' }, { event: 'helper-lost' }]);

    const quick = spawnSystemBridge(script('exit 1'))!;
    quick.onEvent((event) => events.push(event));
    await expect(quick.request({ op: 'state' })).rejects.toThrow('exited');

    const closed = spawnSystemBridge(script('read line; echo \'{"id":1}\'; sleep 5'))!;
    closed.onEvent((event) => events.push(event));
    await closed.request({ op: 'state' });
    closed.close();
    await Bun.sleep(200);
    expect(events).toHaveLength(2);
  },
  15_000,
);
