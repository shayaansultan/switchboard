// Exercise the generated desktop wrapper against a running ChatGPT app's
// authenticated app-tools pipe, without copying credentials or making a turn.
import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { codexBinary, remoteWrapper, wrapperScript } from '../src/buckets/desktop';
import { desktopAdapter } from '../src/buckets/runtime';

const pipe = process.env.CODEX_APP_TOOLS_PIPE_PATH;
for (const routed of [false, true])
  test.skipIf(process.env.SWITCHBOARD_LIVE_TESTS !== '1' || !pipe)(
    `${routed ? 'a bucket' : 'a phone'} wrapper can discover the real app automation tool`,
    async () => {
      const wrapper = remoteWrapper({
        id: 'codex-probe',
        vendor: 'codex',
        name: 'Probe',
        color: '#fff',
        isDefault: false,
      });
      expect(wrapper).not.toBeNull();
      const command = desktopAdapter('desktop-stdio');
      const routedWrapper = path.join(process.env.HOME!, 'routed-wrapper');
      if (routed)
        writeFileSync(
          routedWrapper,
          wrapperScript(codexBinary(), 'http://127.0.0.1:9/v1', {
            bucket: 'Probe',
            runtime: command.execPath,
            adapter: command.script,
            electron: command.electron,
          }),
          { mode: 0o700 },
        );
      const resources = '/Applications/ChatGPT.app/Contents/Resources';
      const plugin = path.join(resources, 'plugins/openai-bundled/plugins/codex-app-tools');
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CODEX_HOME: process.env.HOME!,
        CODEX_MCP_NODE_PATH: path.join(resources, 'cua_node/bin/node'),
      };
      delete env.SWITCHBOARD_CONTROL_SOCKET;
      delete env.SWITCHBOARD_PROFILE;
      const child = spawn(
        routed ? routedWrapper : wrapper!,
        [
          'app-server',
          '--listen',
          'stdio://',
          '-c',
          'features.plugins=false',
          '-c',
          `mcp_servers.codex_app.command=${JSON.stringify(path.join(plugin, 'scripts/launch_codex_app_tools_mcp'))}`,
          '-c',
          `mcp_servers.codex_app.args=[${JSON.stringify(path.join(plugin, 'server.mjs'))}]`,
          '-c',
          'mcp_servers.codex_app.env_vars=["CODEX_APP_TOOLS_PIPE_PATH","CODEX_MCP_NODE_PATH","HOME","PATH"]',
        ],
        { env, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      try {
        const result = await new Promise<{ toolsError: string | null; tools: Record<string, unknown> }>(
          (resolve, reject) => {
            let buffer = '';
            const timeout = setTimeout(() => reject(new Error('App-tools discovery timed out')), 10000);
            child.once('exit', () => {
              clearTimeout(timeout);
              reject(new Error('Codex exited before discovery'));
            });
            const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n');
            child.on('error', reject);
            child.stderr.resume();
            child.stdout.on('data', (chunk: Buffer) => {
              buffer += chunk.toString();
              let end: number;
              while ((end = buffer.indexOf('\n')) !== -1) {
                let message;
                try {
                  message = JSON.parse(buffer.slice(0, end));
                } catch {
                  clearTimeout(timeout);
                  reject(new Error('Codex returned invalid JSON'));
                  return;
                }
                buffer = buffer.slice(end + 1);
                if (message.error) {
                  clearTimeout(timeout);
                  return reject(new Error(message.error.message));
                }
                if (message.id === 1) {
                  send({ method: 'initialized' });
                  send({ id: 2, method: 'mcpServerStatus/list', params: {} });
                }
                if (message.id === 2) {
                  clearTimeout(timeout);
                  const server = message.result.data.find((s: { name: string }) => s.name === 'codex_app');
                  if (!server) reject(new Error('Codex app-tools server is missing'));
                  else resolve(server);
                }
              }
            });
            send({
              id: 1,
              method: 'initialize',
              params: {
                clientInfo: { name: 'switchboard-probe', version: '1' },
                capabilities: { experimentalApi: true },
              },
            });
          },
        );
        expect(result.toolsError).toBeNull();
        expect(result.tools).toHaveProperty('automation_update');
      } finally {
        child.kill('SIGTERM');
      }
    },
    15000,
  );
