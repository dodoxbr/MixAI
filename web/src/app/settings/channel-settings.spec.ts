import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { afterEach, expect, it, vi } from 'vitest';
import { ChannelSettingsComponent } from './channel-settings.component';
import { SessionService } from '../core/session.service';
import { LiveService } from '../core/live.service';
const serverId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const data = () => ({
  serverId,
  settings: {
    revision: 'a'.repeat(64),
    channels: [{ number: 1, name: 'Cavaco', aliases: ['cava'] }],
    aux: [{ number: 1, name: 'Fones', aliases: ['retorno'] }],
    mixerNames: [{ number: 1, name: 'Nome físico' }],
  },
});
afterEach(() => {
  TestBed.resetTestingModule();
  vi.unstubAllGlobals();
});
function setup(fetcher: typeof fetch) {
  vi.stubGlobal('fetch', fetcher);
  const token = signal<string | null>('fixture');
  TestBed.configureTestingModule({
    imports: [ChannelSettingsComponent],
    providers: [
      { provide: SessionService, useValue: { token, role: signal('operator') } },
      {
        provide: LiveService,
        useValue: { connection: signal('online'), hello: signal({ serverId }) },
      },
    ],
  });
  const fixture = TestBed.createComponent(ChannelSettingsComponent);
  fixture.detectChanges();
  return { fixture, component: fixture.componentInstance, token };
}
it('renders immutable physical numbers, hardware comparison and accessible editable labels', async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => data() });
  const { fixture, component } = setup(fetcher as never);
  await vi.waitFor(() => expect(component.settings()).not.toBeNull());
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  expect(el.textContent).toContain('CH1');
  expect(el.textContent).toContain('Nome físico');
  expect(el.textContent).toContain('não será importado automaticamente');
  expect(el.querySelector('input[type=number]')).toBeNull();
  expect(el.querySelector('[aria-label="Nome CH1"]')).not.toBeNull();
  expect(el.textContent).toContain('HA800');
});
it('sends aliases as separate strings to the existing YAML configuration boundary and displays conflicts without retry', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, json: async () => data() })
    .mockResolvedValueOnce({ ok: false, json: async () => ({ message: 'O arquivo mudou' }) });
  const { fixture, component } = setup(fetcher as never);
  await vi.waitFor(() => expect(component.settings()).not.toBeNull());
  component.settings()!.channels[0]!.aliasText = 'cordas\ncordas agudas';
  await component.save();
  fixture.detectChanges();
  const request = JSON.parse(fetcher.mock.calls[1]![1].body);
  expect(request.channels[0]).toEqual({
    number: 1,
    name: 'Cavaco',
    aliases: ['cordas', 'cordas agudas'],
  });
  expect(request.serverId).toBe(serverId);
  expect(component.error()).toBe('O arquivo mudou');
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(
    (fixture.nativeElement as HTMLElement).querySelector('[role=alert]')?.textContent,
  ).toContain('O arquivo mudou');
});
it('discards data returned to a session that has ended', async () => {
  let resolve!: (v: unknown) => void;
  const fetcher = vi.fn(() => new Promise((r) => (resolve = r)));
  const { component, token } = setup(fetcher as never);
  token.set(null);
  resolve({ ok: true, json: async () => data() });
  await vi.waitFor(() => expect(component.busy()).toBe(false));
  expect(component.settings()).toBeNull();
});
