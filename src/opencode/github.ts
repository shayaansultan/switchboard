import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';

const execute = promisify(execFile);

export function gitEnvironment(inherited: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv {
  const count = Number(inherited.GIT_CONFIG_COUNT ?? '0');
  const env = { ...inherited };
  // gh prefers GH_TOKEN. Remove its fallback alias rather than leave a second
  // account's inherited token available to tools using a different convention.
  delete env.GITHUB_TOKEN;

  if (!Number.isSafeInteger(count) || count < 0 || count > 1000) {
    throw new Error('Invalid inherited Git configuration count');
  }

  // Process-local helper settings preserve repository author configuration and
  // avoid global `gh auth switch`. The credential never appears in argv or files.
  return {
    ...env,
    GH_HOST: 'github.com',
    GH_TOKEN: token,
    GIT_CONFIG_COUNT: String(count + 2),
    [`GIT_CONFIG_KEY_${count}`]: 'credential.https://github.com.helper',
    [`GIT_CONFIG_VALUE_${count}`]: '',
    [`GIT_CONFIG_KEY_${count + 1}`]: 'credential.https://github.com.helper',
    [`GIT_CONFIG_VALUE_${count + 1}`]: '!gh auth git-credential',
  };
}

export async function bindGitHub(login: string | undefined, inherited: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  if (!login) return inherited;

  const lookup = { ...inherited };
  delete lookup.GH_TOKEN;
  delete lookup.GITHUB_TOKEN;
  // OpenCode's XDG root is isolated. Credential lookup must still reach the
  // existing CLI login store, including when oc is invoked inside a profile.
  const configDir =
    inherited.SWITCHBOARD_GH_CONFIG_DIR ??
    process.env.GH_CONFIG_DIR ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'gh');
  lookup.GH_CONFIG_DIR = configDir;

  try {
    const { stdout } = await execute('gh', ['auth', 'token', '--hostname', 'github.com', '--user', login], {
      env: lookup,
      timeout: 10000,
    });
    const token = stdout.trim();

    if (!token) throw new Error('Empty credential');
    return { ...gitEnvironment(inherited, token), SWITCHBOARD_GH_CONFIG_DIR: configDir };
  } catch {
    throw new Error(
      `GitHub CLI has no usable login for ${login}. Sign that account into gh; no global account switch was made.`,
    );
  }
}
