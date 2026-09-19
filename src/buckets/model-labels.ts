import { Transform, type TransformCallback } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

type Message = { id?: string | number; method?: string; result?: { data?: unknown[] } };

// Decorate only the app-server model/list response. Model IDs, capabilities,
// requests and inference events retain their original values. In particular,
// this does not replace Codex's model catalog with a stale local copy.
export class ModelLabels {
  private readonly pending = new Set<string | number>();

  request(line: string): string {
    const message = parse(line);
    if (message?.method === 'model/list' && message.id !== undefined) this.pending.add(message.id);
    return line;
  }

  response(line: string): string {
    const message = parse(line);
    if (message?.id === undefined || !this.pending.delete(message.id)) return line;
    if (!Array.isArray(message.result?.data)) return line;
    let changed = false;
    const data = message.result.data.map((entry) => {
      if (entry === null || typeof entry !== 'object') return entry;
      const model = entry as Record<string, unknown>;
      if (typeof model.displayName !== 'string') return entry;
      changed = true;
      return { ...model, displayName: `Proxy · ${model.displayName}` };
    });
    return changed ? JSON.stringify({ ...message, result: { ...message.result, data } }) : line;
  }
}

function parse(line: string): Message | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Message;
  } catch {
    /* Pass non-JSON output through verbatim. */
  }
  return undefined;
}

// JSON-RPC stdio is newline-delimited. Decode across arbitrary pipe chunk and
// UTF-8 boundaries; preserve the original bytes for messages we don't decorate.
export class JsonLines extends Transform {
  private readonly decoder = new StringDecoder('utf8');
  private buffered = '';
  constructor(private readonly rewrite: (line: string) => string) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.buffered += this.decoder.write(chunk);
    let end: number;
    while ((end = this.buffered.indexOf('\n')) !== -1) {
      const line = this.buffered.slice(0, end);
      this.buffered = this.buffered.slice(end + 1);
      this.push(this.rewrite(line) + '\n');
    }
    callback();
  }

  override _flush(callback: TransformCallback): void {
    this.buffered += this.decoder.end();
    if (this.buffered) this.push(this.rewrite(this.buffered));
    callback();
  }
}
