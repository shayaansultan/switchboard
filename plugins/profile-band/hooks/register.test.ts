import { expect, mock, test } from 'claude-code/testing';
import type { On } from 'claude-code';
import { bandFacts, bar, fitBand, labelColor, pace, parseUsage, resetsOn, until } from './register.tsx';

const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
};
const SURFACES = ['desktop', 'terminal'] as const;
const PLUGIN = 'switchboard-profile-band';
const NOW = Date.parse('2026-10-05T07:00:00Z');
const ENV = {
  SWITCHBOARD_PROFILE: 'claude-answerthis',
  SWITCHBOARD_PROFILE_NAME: 'AnswerThis',
  SWITCHBOARD_PROFILE_COLOR: '#ec4899',
  SWITCHBOARD_COMMAND: '/bin/switchboard',
};
const USAGE = JSON.stringify({
  profiles: [
    {
      id: 'claude-answerthis',
      usage: {
        status: 'ok',
        plan: 'Max 20x',
        windows: [
          { label: '5h', remaining: 12, resetsAt: '2026-10-05T09:30:00Z', severity: 'warning' },
          { label: '7d', remaining: 71, resetsAt: '2026-10-09T18:00:00Z', severity: null },
          { label: '7d Fable', remaining: 100, resetsAt: '2026-10-09T18:00:00Z', severity: 'normal' },
        ],
      },
    },
  ],
});

const RAN = { exitCode: 0, stdout: USAGE, stderr: '', isStdoutTruncated: false, isStderrTruncated: false };
const SESSION = { startedAt: 0, context: { window: 200000, percent: 38 }, rateLimits: [], cost: { usd: 4.123 } };
const WIDE = { ...PROPS, bodyColumns: 200 };

// Stands for the engine's own band, which the mod leaves in place.
const ENGINE_BAND: Parameters<On<'ui.render'>>[1] = ($, e) => {
  const { Text } = $.ui.resolve(e);
  return h(Text, null, 'engine band');
};

for (const surface of SURFACES) {
  test(`${surface}: shows name, plan, context, cost and limits on the profile's colour`, async ($, on) => {
    mock.env(on, ENV);
    const clock = mock.clock(on, { now: NOW });
    on('process.run', (_, e) => {
      expect(e.argv).toEqual(['/bin/switchboard', 'usage', 'claude-answerthis', '--max-age', '15m', '--no-renew']);
      return { value: RAN };
    });
    on('session.usage', () => ({ value: SESSION }));
    on('session.start', (_, e) => ({ cwd: e.cwd }));
    await $.session.start({ cwd: '/', surface, isInteractive: true });
    // The first lookups run unawaited after the session starts, as in a session.
    await clock.settle();
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: WIDE });
    expect((await ui.find({ type: 'Box' }))?.props).toMatchObject({ width: '100%', backgroundColor: '#ec4899' });
    expect((await ui.find({ type: 'Text', text: 'AnswerThis' }))?.props).toMatchObject({
      color: '#ffffff',
      bold: true,
    });
    expect(await ui.find({ type: 'Text', text: '  Max 20x · context 38% · $4.12' })).toBeDefined();
    const fiveHour = await ui.find({
      type: 'Text',
      text: /^5h █░░░░░░░░░ 12% · resets in 2h 30m · runs out \d\d:\d\d$/,
    });
    expect(fiveHour?.props.bold).toBe(true);
    const sevenDay = await ui.find({
      type: 'Text',
      text: /7d ███████░░░ 71% · resets \w{3} \d\d:\d\d · on track$/,
    });
    expect(sevenDay?.props.bold).toBe(false);
    expect(await ui.find({ text: /Fable/ })).toBeUndefined();
  });

  test(`${surface}: the limits refresh every five minutes`, async ($, on) => {
    mock.env(on, ENV);
    const clock = mock.clock(on, { now: NOW });
    let stdout = USAGE;
    on('process.run', () => ({ value: { ...RAN, stdout } }));
    on('session.start', (_, e) => ({ cwd: e.cwd }));
    await $.session.start({ cwd: '/', surface, isInteractive: true });
    await clock.settle();
    stdout = USAGE.replace('"remaining":12', '"remaining":3');
    await clock.advance(5 * 60 * 1000);
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: PROPS });
    expect(await ui.find({ text: /5h ░░░░░░░░░░ 3%/ })).toBeDefined();
  });

  test(`${surface}: a narrow band keeps the name and drops the limits`, async ($, on) => {
    mock.env(on, ENV);
    const clock = mock.clock(on, { now: NOW });
    on('process.run', () => ({ value: RAN }));
    on('session.start', (_, e) => ({ cwd: e.cwd }));
    await $.session.start({ cwd: '/', surface, isInteractive: true });
    // The first lookup runs unawaited after the session starts, as in a session.
    await clock.settle();
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'AbovePrompt',
      props: { ...PROPS, bodyColumns: 30 },
    });
    expect(await ui.find({ type: 'Text', text: 'AnswerThis' })).toBeDefined();
    expect(await ui.find({ text: /%/ })).toBeUndefined();
  });

  test(`${surface}: without the command the band still names the profile`, async ($, on) => {
    mock.env(on, { SWITCHBOARD_PROFILE_NAME: 'AnswerThis', SWITCHBOARD_PROFILE_COLOR: '#ec4899' });
    const clock = mock.clock(on, { now: NOW });
    on('session.start', (_, e) => ({ cwd: e.cwd }));
    await $.session.start({ cwd: '/', surface, isInteractive: true });
    // The first lookup runs unawaited after the session starts, as in a session.
    await clock.settle();
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: PROPS });
    expect(await ui.find({ type: 'Text', text: 'AnswerThis' })).toBeDefined();
    expect(await ui.find({ text: /5h|7d/ })).toBeUndefined();
  });

  test(`${surface}: the Default profile draws no band`, async ($, on) => {
    mock.env(on, {});
    on('ui.render', ENGINE_BAND);
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: PROPS });
    expect(await ui.find({ text: 'engine band' })).toBeDefined();
    expect(await ui.find({ type: 'Box' })).toBeUndefined();
  });

  test(`${surface}: yields to a survey`, async ($, on) => {
    mock.env(on, ENV);
    on('ui.render', ENGINE_BAND);
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'AbovePrompt',
      props: { ...PROPS, hasSurvey: true },
    });
    expect(await ui.find({ text: 'engine band' })).toBeDefined();
    expect(await ui.find({ text: 'AnswerThis' })).toBeUndefined();
  });
}

test('usage output without numbers shows no limits', () => {
  expect(parseUsage('not json')).toBeNull();
  expect(parseUsage(JSON.stringify({ profiles: [{ usage: { status: 'not-signed-in', windows: [] } }] }))).toBeNull();
});

test('reset times read as hours, minutes or days', () => {
  expect(until('2026-10-05T07:40:00Z', NOW)).toBe('40m');
  expect(until('2026-10-05T09:05:00Z', NOW)).toBe('2h 5m');
  expect(until('2026-10-09T07:00:00Z', NOW)).toBe('4d');
  expect(until('2026-10-05T06:00:00Z', NOW)).toBeNull();
});

test('the 7-day reset reads as a local day and time', () => {
  expect(resetsOn('2026-10-09T18:00:00Z', NOW, 'UTC')).toBe('Fri 18:00');
  expect(resetsOn('2026-10-09T17:59:59.926Z', NOW, 'UTC')).toBe('Fri 18:00');
  expect(resetsOn('2026-10-09T18:00:00Z', NOW, 'Asia/Singapore')).toBe('Sat 02:00');
  expect(resetsOn('2026-10-05T06:00:00Z', NOW, 'UTC')).toBeNull();
});

const WEEK = 7 * 24 * 3600 * 1000;
const window7d = (remaining: number, resetsIn: number) => ({
  label: '7d',
  remaining,
  resetsAt: new Date(NOW + resetsIn).toISOString(),
  severity: null,
});

test('pace says on track when less of the week is gone than of the limit', () => {
  // 3.5 days in, 40% used.
  expect(pace(window7d(60, WEEK / 2), NOW)).toBe('ok');
  expect(pace(window7d(100, WEEK / 2), NOW)).toBe('ok');
});

test('pace says when a window would run out at the rate so far', () => {
  // 3.5 days in, 70% used: the last 30% lasts 1.5 days.
  expect(pace(window7d(30, WEEK / 2), NOW)).toEqual({ runsOutAt: NOW + (30 * (WEEK / 2)) / 70 });
});

test('pace says nothing in the first tenth of a window', () => {
  expect(pace(window7d(10, WEEK * 0.95), NOW)).toBeNull();
  expect(pace({ ...window7d(10, 0), resetsAt: null }, NOW)).toBeNull();
});

test('a bar shows what is left in tenths', () => {
  expect(bar(72)).toBe('███████░░░');
  expect(bar(100)).toBe('██████████');
  expect(bar(3)).toBe('░░░░░░░░░░');
});

test('a narrow band gives up detail in a fixed order', () => {
  const usage = parseUsage(USAGE.replace('"remaining":12', '"remaining":72').replace('"warning"', 'null'));
  const facts = bandFacts({ name: 'AnswerThis' }, usage, { context: 38, costUsd: 4.12 }, NOW, 'UTC');
  const at = (columns: number) => {
    const b = fitBand(facts, columns);
    return [b.detail, ...b.limits.map((l) => l.text)];
  };
  expect(at(200)).toEqual([
    '  Max 20x · context 38% · $4.12',
    '5h ███████░░░ 72% · resets in 2h 30m',
    '7d ███████░░░ 71% · resets Fri 18:00 · on track',
  ]);
  expect(at(130)).toEqual([
    '  Max 20x · context 38%',
    '5h ███████░░░ 72% · resets in 2h 30m',
    '7d ███████░░░ 71% · resets Fri 18:00 · on track',
  ]);
  expect(at(120)).toEqual([
    '  Max 20x · context 38%',
    '5h ███████░░░ 72% · resets in 2h 30m',
    '7d ███████░░░ 71% · resets Fri 18:00',
  ]);
  expect(at(100)).toEqual(['  Max 20x · context 38%', '5h ███████░░░ 72% · resets in 2h 30m', '7d ███████░░░ 71%']);
  expect(at(60)).toEqual(['  Max 20x', '5h 72%', '7d 71%']);
  expect(at(12)).toEqual(['']);
});

test('a session that has spent under a cent shows no cost', () => {
  const facts = bandFacts({ name: 'AnswerThis' }, null, { context: 2, costUsd: 0.004 }, NOW, 'UTC');
  expect(fitBand(facts, 200).detail).toBe('  context 2%');
});

test('an empty window says so with its bar alone', () => {
  expect(pace(window7d(0, WEEK / 2), NOW)).toBeNull();
});

test('a narrow band keeps the window with a pace warning longest', () => {
  const usage = {
    plan: 'Max 20x',
    windows: [{ label: '5h', remaining: 72, resetsAt: null, severity: null }, window7d(18, WEEK / 4)],
  };
  const facts = bandFacts({ name: 'AnswerThis' }, usage, null, NOW, 'UTC');
  expect(fitBand(facts, 45).limits.map((l) => l.text)).toEqual(['7d 18% · runs out Tue 10:40']);
});

test('a pace warning outlasts the reset time it shares a window with', () => {
  const usage = { plan: 'Max 20x', windows: [window7d(18, WEEK / 4)] };
  const facts = bandFacts({ name: 'AnswerThis' }, usage, null, NOW, 'UTC');
  expect(fitBand(facts, 200).limits[0]).toMatchObject({
    text: '7d ██░░░░░░░░ 18% · resets Wed 01:00 · runs out Tue 10:40',
    isBold: true,
  });
  expect(fitBand(facts, 70).limits[0].text).toBe('7d ██░░░░░░░░ 18% · runs out Tue 10:40');
});

test('a light profile colour gets dark text', () => {
  expect(labelColor('#fde047')).toBe('#1a1a1a');
  expect(labelColor('#3b82f6')).toBe('#ffffff');
  expect(labelColor('red')).toBeUndefined();
});
