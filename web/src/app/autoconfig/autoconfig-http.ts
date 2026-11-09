import { InjectionToken, inject } from '@angular/core';
import { SessionService } from '../core/session.service';
import { LiveService } from '../core/live.service';
import type { AutoAdapter } from './autoconfig-contract';
export class AutoHttpError extends Error {
  constructor(readonly code: string) {
    super('AutoConfig request failed');
  }
}
export const AUTO_ADAPTER = new InjectionToken<AutoAdapter>('AUTOCONFIG_HTTP', {
  providedIn: 'root',
  factory: () => {
    const session = inject(SessionService),
      live = inject(LiveService);
    return {
      async request(path, body, signal) {
        const token = session.token();
        const h = live.hello();
        if (
          !token ||
          session.role() !== 'operator' ||
          h?.role !== 'operator' ||
          !['lab', 'mock'].includes(h?.mode ?? '') ||
          live.connection() !== 'online'
        )
          throw new AutoHttpError('UNAUTHORIZED');
        if (!/^\/api\/autoconfig(?:\/[A-Za-z0-9_-]{6,64}(?:\/actions)?)?$/.test(path))
          throw new AutoHttpError('INVALID');
        const response = await fetch(path, {
          method: body ? 'POST' : 'GET',
          body: body ? JSON.stringify(body) : undefined,
          signal,
          cache: 'no-store',
          mode: 'same-origin',
          credentials: 'omit',
          redirect: 'error',
          headers: {
            authorization: `Bearer ${token}`,
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
        });
        const data = await response.json();
        if (!response.ok)
          throw new AutoHttpError(
            response.status === 401
              ? 'UNAUTHORIZED'
              : response.status === 403
                ? 'FORBIDDEN'
                : response.status === 409
                  ? 'CONFLICT'
                  : typeof data?.code === 'string'
                    ? data.code
                    : 'INVALID',
          );
        return data;
      },
    };
  },
});
