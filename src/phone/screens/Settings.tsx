// Settings on the phone: the Mac it is paired with, how to show sessions
// (kept on this phone only), and unpairing. Notifications join this screen
// when the Mac can send them.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type * as React from 'react';
import type { Overview } from '../../remote/hub';
import { ago } from '../../shared/time';
import { Dot, PageTitle, SectionTitle } from '../components/bits';
import { Button } from '../components/ui/button';
import { Switch } from '../components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group';
import { useTRPC, type Link } from '../data';
import { setPrefs, usePrefs, type Prefs } from '../prefs';

function Group({ children }: { children: React.ReactNode }) {
  return <div className="overflow-hidden rounded-2xl border border-border bg-card">{children}</div>;
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-2 border-b border-border px-3.5 py-3 last:border-b-0">{children}</div>;
}

function Choice<K extends 'inbox' | 'steps' | 'text'>({
  name,
  label,
  options,
}: {
  name: K;
  label: string;
  options: [Prefs[K], string][];
}) {
  const prefs = usePrefs();
  return (
    <Row>
      <span className="font-medium">{label}</span>
      <ToggleGroup
        type="single"
        value={prefs[name]}
        onValueChange={(v) => v && setPrefs({ [name]: v } as Partial<Prefs>)}
        aria-label={label}
      >
        {options.map(([value, text]) => (
          <ToggleGroupItem key={value} value={value}>
            {text}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </Row>
  );
}

export function Settings({ overview, link }: { overview: Overview | undefined; link: Link }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const prefs = usePrefs();
  const me = useQuery(trpc.me.queryOptions());
  const unpair = useMutation(
    trpc.unpair.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries(),
    }),
  );
  return (
    <main className="px-gutter pt-safe flex flex-col gap-5 pb-6">
      <header className="pt-6">
        <PageTitle>Settings</PageTitle>
      </header>

      <section className="flex flex-col gap-2">
        <SectionTitle>Mac</SectionTitle>
        <Group>
          <Row>
            <span className="flex items-center gap-2.5">
              <span
                className={link === 'live' ? 'size-2 rounded-full bg-run' : 'size-2 rounded-full bg-muted-foreground'}
              />
              <span className="flex flex-1 flex-col">
                <span className="font-semibold">{overview?.host ?? 'Your Mac'}</span>
                <span className="text-xs text-muted-foreground">
                  {overview ? `${overview.profiles.length} profiles` : ''}
                </span>
              </span>
              <span className={link === 'live' ? 'text-[13px] text-run-text' : 'text-[13px] text-muted-foreground'}>
                {link === 'live' ? 'Connected' : 'Reconnecting'}
              </span>
            </span>
          </Row>
        </Group>
      </section>

      <section className="flex flex-col gap-2">
        <SectionTitle>Show</SectionTitle>
        <Group>
          <Choice
            name="inbox"
            label="Inbox shows"
            options={[
              ['desktop', 'Desktop sessions'],
              ['all', 'All sessions'],
            ]}
          />
          <Choice
            name="steps"
            label="Tool steps"
            options={[
              ['folded', 'Folded'],
              ['open', 'Open'],
            ]}
          />
          <Choice
            name="text"
            label="Text size"
            options={[
              ['smaller', 'Smaller'],
              ['default', 'Default'],
              ['larger', 'Larger'],
            ]}
          />
          <Row>
            <span className="font-medium">Profiles in the inbox</span>
            {(overview?.profiles ?? []).map((p) => (
              <label key={p.id} className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2">
                  <Dot color={p.color} />
                  {p.name}
                </span>
                <Switch
                  checked={!prefs.hidden.includes(p.id)}
                  onCheckedChange={(on) =>
                    setPrefs({ hidden: on ? prefs.hidden.filter((id) => id !== p.id) : [...prefs.hidden, p.id] })
                  }
                  aria-label={`Show ${p.name}`}
                />
              </label>
            ))}
          </Row>
        </Group>
        <p className="m-0 text-xs text-muted-foreground">These stay on this phone.</p>
      </section>

      <section className="flex flex-col gap-2">
        <SectionTitle>This phone</SectionTitle>
        <Group>
          <Row>
            <span className="flex justify-between">
              <span>Name</span>
              <span className="text-muted-foreground">{me.data?.device.name ?? '…'}</span>
            </span>
          </Row>
          <Row>
            <span className="flex justify-between">
              <span>Paired</span>
              <span className="text-muted-foreground">{me.data ? ago(me.data.device.createdAt) : '…'}</span>
            </span>
          </Row>
          <Row>
            <Button variant="destructive" onClick={() => unpair.mutate()} disabled={unpair.isPending}>
              {unpair.isPending ? 'Unpairing…' : 'Unpair this phone'}
            </Button>
          </Row>
        </Group>
        <p className="m-0 text-xs text-muted-foreground">
          Unpairing signs this phone out of the Mac. Pair again from the Mac's Phone tab.
        </p>
      </section>
    </main>
  );
}
