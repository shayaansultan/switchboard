import { expect, mock, test } from 'claude-code/testing';
import type { On } from 'claude-code';
import { labelColor, parseUsage, until } from './register.tsx';

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
          { label: '7d', remaining: 71, resetsAt: '2026-10-09T18:00:00Z', severity: 'normal' },
          { label: '7d Fable', remaining: 100, resetsAt: '2026-10-09T18:00:00Z', severity: 'normal' },
        ],
      },
    },
  ],
});

const RAN = { exitCode: 0, stdout: USAGE, stderr: '', isStdoutTruncated: false, isStderrTruncated: false };

// Stands for the engine's own band, which the mod leaves in place.
const ENGINE_BAND: Parameters<On<'ui.render'>>[1] = ($, e) => {
  const { Text } = $.ui.resolve(e);
  return h(Text, null, 'engine band');
};

for (const surface of SURFACES) {
  test(`${surface}: shows name, plan and limits left on the profile's colour`, async ($, on) => {
    mock.env(on, ENV);
    const clock = mock.clock(on, { now: NOW });
    on('process.run', (_, e) => {
      expect(e.argv).toEqual(['/bin/switchboard', 'usage', 'claude-answerthis', '--max-age', '15m']);
      return { value: RAN };
    });
    on('session.start', (_, e) => ({ cwd: e.cwd }));
    await $.session.start({ cwd: '/', surface, isInteractive: true });
    // The first lookup runs unawaited after the session starts, as in a session.
    await clock.settle();
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: PROPS });
    expect((await ui.find({ type: 'Box' }))?.props).toMatchObject({ width: '100%', backgroundColor: '#ec4899' });
    expect((await ui.find({ type: 'Text', text: 'AnswerThis' }))?.props).toMatchObject({
      color: '#ffffff',
      bold: true,
    });
    expect(await ui.find({ type: 'Text', text: 'Max 20x' })).toBeDefined();
    expect((await ui.find({ type: 'Text', text: '5h 12% left · resets in 2h 30m' }))?.props.bold).toBe(true);
    expect(await ui.find({ type: 'Text', text: '7d 71% left' })).toBeDefined();
    expect(await ui.find({ text: 'Fable' })).toBeUndefined();
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
    expect(await ui.find({ text: /5h 3% left/ })).toBeDefined();
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
    expect(await ui.find({ text: /left/ })).toBeUndefined();
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
    expect(await ui.find({ text: /left/ })).toBeUndefined();
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

test('a light profile colour gets dark text', () => {
  expect(labelColor('#fde047')).toBe('#1a1a1a');
  expect(labelColor('#3b82f6')).toBe('#ffffff');
  expect(labelColor('red')).toBeUndefined();
});
