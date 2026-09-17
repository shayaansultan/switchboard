const { test, expect } = require('bun:test');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const { recoverClaudeToken } = require('../src/claude-recovery');

test('does not spawn if another CLI already renewed the credential', async () => {
  await recoverClaudeToken('already-renewed', {
    readCredential: async () => ({ token: 'fresh', expiresAt: Date.now() + 60_000 }),
    spawnCli: () => {
      throw new Error('must not spawn');
    },
  });
});

test('default profile clears inherited config redirection instead of relocating onboarding', async () => {
  const { VENDORS } = require('../src/store');
  let credential = { token: 'old', expiresAt: 1 };
  let env;
  await recoverClaudeToken(VENDORS.claude.defaultHome, {
    pollMs: 5,
    readCredential: async () => credential,
    spawnCli: (cwd, givenEnv) =>
      fakeChild(() => {
        env = givenEnv;
        expect(givenEnv.PWD).toBe(cwd);
        setTimeout(() => {
          credential = { token: 'fresh', expiresAt: Date.now() + 60_000 };
        }, 10);
      }),
  });
  expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
});

function fakeChild(onSpawn) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = undefined;
  child.exitCode = null;
  child.kill = () => {};
  child.stdin.on('finish', () => {
    child.exitCode = 0;
    child.emit('close', 0);
  });
  onSpawn(child);
  return child;
}

test('starts in an empty directory with the exact profile and accepts only its trust prompt', async () => {
  let credential = { token: 'old', expiresAt: 1 };
  let cwd;
  let env;
  const writes = [];
  await recoverClaudeToken('/profile/one', {
    pollMs: 5,
    timeoutMs: 500,
    readCredential: async () => credential,
    spawnCli: (givenCwd, givenEnv) =>
      fakeChild((child) => {
        cwd = givenCwd;
        env = givenEnv;
        child.stdin.on('data', (data) => writes.push(String(data)));
        setTimeout(
          () =>
            child.stdout.write(
              `Do you trust the files in this folder?\r\n${givenCwd}\r\nNo, exit\r\nYes, I trust this folder`,
            ),
          5,
        );
        setTimeout(() => {
          credential = { token: 'new', expiresAt: Date.now() + 60_000 };
        }, 20);
      }),
  });
  expect(env.CLAUDE_CONFIG_DIR).toBe('/profile/one');
  expect(env.CLAUDE_CODE_SAFE_MODE).toBe('1');
  expect(writes).toEqual(['\x1b[B\r']);
  expect(fs.existsSync(cwd)).toBe(false);
});

test('deduplicates concurrent recovery for one profile but isolates different profiles', async () => {
  const credentials = new Map([
    ['a', { token: 'old-a', expiresAt: 1 }],
    ['b', { token: 'old-b', expiresAt: 1 }],
  ]);
  let spawns = 0;
  const attempt = (profile) =>
    recoverClaudeToken(profile, {
      pollMs: 5,
      timeoutMs: 500,
      readCredential: async () => credentials.get(profile),
      spawnCli: () =>
        fakeChild(() => {
          spawns++;
          setTimeout(() => credentials.set(profile, { token: `new-${profile}`, expiresAt: Date.now() + 60_000 }), 20);
        }),
    });
  await Promise.all([attempt('a'), attempt('a'), attempt('b')]);
  expect(spawns).toBe(2);
});

test('aborts sign-in prompts without exposing their output and cools down failures', async () => {
  let spawns = 0;
  const options = {
    pollMs: 5,
    timeoutMs: 100,
    readCredential: async () => ({ token: 'old', expiresAt: 1 }),
    spawnCli: () =>
      fakeChild((child) => {
        spawns++;
        setTimeout(() => child.stdout.write('Open browser to sign in using SECRET'), 5);
      }),
  };
  await expect(recoverClaudeToken('sign-in', options)).rejects.toThrow('open this profile in Terminal');
  await expect(recoverClaudeToken('sign-in', options)).rejects.toThrow('recently failed');
  expect(spawns).toBe(1);
});

test('times out, cleans its temporary directory, and reports no captured output', async () => {
  let cwd;
  const options = {
    pollMs: 5,
    timeoutMs: 25,
    readCredential: async () => ({ token: 'old', expiresAt: 1 }),
    spawnCli: (givenCwd) => {
      cwd = givenCwd;
      return fakeChild((child) => child.stdout.write('token=SECRET'));
    },
  };
  await expect(recoverClaudeToken('timeout', options)).rejects.toThrow('did not renew');
  expect(fs.existsSync(cwd)).toBe(false);
});

test('scrubs auth overrides and ignores unknown trust text', async () => {
  const inherited = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_PROFILE',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'CLAUDE_CODE_REMOTE_CONTROL',
  ];
  const original = Object.fromEntries(inherited.map((key) => [key, process.env[key]]));
  for (const key of inherited) process.env[key] = 'must-not-leak';
  let credential = { token: 'old', expiresAt: 1 };
  let childEnv;
  const writes = [];
  try {
    await recoverClaudeToken('scrubbed', {
      pollMs: 5,
      timeoutMs: 500,
      readCredential: async () => credential,
      spawnCli: (_cwd, env) =>
        fakeChild((child) => {
          childEnv = env;
          child.stdin.on('data', (data) => writes.push(String(data)));
          child.stdout.write('A document asks whether you trust this project directory.');
          setTimeout(() => {
            credential = { token: 'new', expiresAt: Date.now() + 60_000 };
          }, 20);
        }),
    });
  } finally {
    for (const key of inherited) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
  for (const key of inherited) expect(childEnv[key]).toBeUndefined();
  expect(writes).toEqual([]);
});

test('removes its temporary directory when spawning throws', async () => {
  let cwd;
  await expect(
    recoverClaudeToken('spawn-throws', {
      readCredential: async () => ({ token: 'old', expiresAt: 1 }),
      spawnCli: (givenCwd) => {
        cwd = givenCwd;
        throw new Error('SECRET spawn detail');
      },
    }),
  ).rejects.toThrow('Claude could not be started for session renewal');
  expect(fs.existsSync(cwd)).toBe(false);
});

test('sanitizes child errors and tolerates stdin EPIPE', async () => {
  await expect(
    recoverClaudeToken('child-error', {
      pollMs: 5,
      timeoutMs: 100,
      readCredential: async () => ({ token: 'old', expiresAt: 1 }),
      spawnCli: () =>
        fakeChild((child) => {
          setTimeout(() => {
            child.stdin.emit('error', Object.assign(new Error('write EPIPE SECRET'), { code: 'EPIPE' }));
            child.emit('error', new Error('spawn ENOENT /secret/path'));
          }, 5);
        }),
    }),
  ).rejects.toThrow('Claude could not be started for session renewal');
});

test('accepts the current workspace trust screen only for its own directory', async () => {
  let credential = { token: 'old', expiresAt: 1 };
  const writes = [];
  await recoverClaudeToken('current-layout', {
    pollMs: 5,
    timeoutMs: 500,
    readCredential: async () => credential,
    spawnCli: (cwd) =>
      fakeChild((child) => {
        const screen = (folder) =>
          `Accessing workspace:\n\n${folder}\n\nQuick safety check: Is this a project you created or one you trust?\n` +
          'No, exit\nYes, I trust this folder';
        child.stdin.on('data', (data) => {
          writes.push(String(data));
          credential = { token: 'new', expiresAt: Date.now() + 60_000 };
        });
        setTimeout(() => child.stdout.write(screen('/some/other/directory')), 5);
        setTimeout(() => {
          expect(writes).toEqual([]);
          // Ink uses cursor positioning instead of literal spaces between words.
          child.stdout.write(screen(fs.realpathSync(cwd)).replaceAll(' ', '\x1b[12G'));
        }, 20);
      }),
  });
  expect(writes).toEqual(['\x1b[B\r']);
});

test('bounds a credential read that never resolves', async () => {
  await expect(
    recoverClaudeToken('blocked-reader', {
      timeoutMs: 25,
      readCredential: () => new Promise(() => {}),
      spawnCli: () => {
        throw new Error('must not spawn');
      },
    }),
  ).rejects.toThrow('did not renew');
});
