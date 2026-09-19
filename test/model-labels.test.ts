import { expect, test } from 'bun:test';
import { ModelLabels, JsonLines } from '../src/buckets/model-labels';

test('only matching model/list display names change; model IDs and capabilities are retained', () => {
  const labels = new ModelLabels();
  const request = '{"id":7,"method":"model/list","params":{"includeHidden":true}}';
  expect(labels.request(request)).toBe(request);
  const model = {
    id: 'gpt-6-astra',
    model: 'gpt-6-astra',
    displayName: 'GPT-6 Astra',
    hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
    futureCapability: { enabled: true },
  };
  const response = { id: 7, result: { data: [model], nextCursor: 'page-2', futureField: true } };
  expect(JSON.parse(labels.response(JSON.stringify(response)))).toEqual({
    ...response,
    result: { ...response.result, data: [{ ...model, displayName: 'Proxy · GPT-6 Astra' }] },
  });
  const inference = '{"method":"item/completed","params":{"text":"model/list"}}';
  expect(labels.response(inference)).toBe(inference);
  // IDs are typed and each pending request is consumed only once.
  labels.request('{"id":"7","method":"model/list"}');
  expect(labels.response(JSON.stringify(response))).toBe(JSON.stringify(response));
  const other = '{"id":8,"result":{"data":[{"displayName":"Untouched"}]}}';
  expect(labels.response(other)).toBe(other);
  expect(labels.response('{"id":"7","error":{"message":"no models"}}')).toBe(
    '{"id":"7","error":{"message":"no models"}}',
  );
  expect(labels.response('not json')).toBe('not json');
  expect(labels.response('null')).toBe('null');
});

test('JSON lines preserve multibyte text and arbitrary pipe chunks without editing inference', async () => {
  const labels = new ModelLabels();
  labels.request('{"id":1,"method":"model/list"}');
  const line = '{"id":1,"result":{"data":[{"displayName":"GPT · 世界","model":"gpt-6-astra"}]}}';
  const original = ' {"method":"turn/completed","params":{"text":"世界"}}\r\n';
  const stream = new JsonLines((message) => labels.response(message));
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  for (const byte of Buffer.from(line + '\n' + original + 'last partial line')) stream.write(Buffer.from([byte]));
  stream.end();
  await done;
  const result = Buffer.concat(chunks).toString();
  expect(JSON.parse(result.split('\n')[0]).result.data[0].displayName).toBe('Proxy · GPT · 世界');
  expect(result).toEndWith(original + 'last partial line');
});
