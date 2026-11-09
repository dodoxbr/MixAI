import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { AUTO_ADAPTER } from './autoconfig-http';
import { LiveService } from '../core/live.service';
import { SessionService } from '../core/session.service';
afterEach(() => vi.unstubAllGlobals());
function boot(mode = 'lab') {
  TestBed.configureTestingModule({
    providers: [
      {
        provide: SessionService,
        useValue: { token: signal('test-secret'), role: signal('operator') },
      },
      {
        provide: LiveService,
        useValue: { hello: signal({ mode, role: 'operator' }), connection: signal('online') },
      },
    ],
  });
  return TestBed.inject(AUTO_ADAPTER);
}
it('uses only authenticated same-origin AutoConfig HTTP with no cache, redirect, cookies or retry', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ value: 'server' }) });
  vi.stubGlobal('fetch', fetch);
  const adapter = boot();
  const signal = new AbortController().signal;
  expect(
    await adapter.request('/api/autoconfig/plan-00001/actions', { action: 'approve' }, signal),
  ).toEqual({ value: 'server' });
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]![1]).toMatchObject({
    method: 'POST',
    signal,
    cache: 'no-store',
    mode: 'same-origin',
    credentials: 'omit',
    redirect: 'error',
    headers: { authorization: 'Bearer test-secret' },
  });
  await expect(
    adapter.request('https://external.invalid', undefined, signal),
  ).rejects.toMatchObject({ code: 'INVALID' });
  expect(fetch).toHaveBeenCalledOnce();
});
it.each([401, 403, 409, 503])(
  'propagates server status %s without executing retries',
  async (status) => {
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status,
      json: async () => ({ code: 'DEPENDENCY_UNAVAILABLE' }),
    });
    vi.stubGlobal('fetch', fetch);
    const adapter = boot();
    await expect(
      adapter.request('/api/autoconfig', undefined, new AbortController().signal),
    ).rejects.toHaveProperty('code');
    expect(fetch).toHaveBeenCalledOnce();
  },
);
it('refuses REAL before fetching', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const adapter = boot('real');
  await expect(
    adapter.request('/api/autoconfig', undefined, new AbortController().signal),
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  expect(fetch).not.toHaveBeenCalled();
});
it('supports MOCK with the same server-only contract', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  vi.stubGlobal('fetch', fetch);
  await boot('mock').request('/api/autoconfig', undefined, new AbortController().signal);
  expect(fetch).toHaveBeenCalledOnce();
});
