import { InjectionToken, inject } from '@angular/core';
import { SessionService } from '../core/session.service';
import { LiveService } from '../core/live.service';
import type { AutoAdapter } from './autoconfig-contract';
export class AutoHttpError extends Error {
  /** `detail` is the server's sanitized code (e.g. STALE_STATE); never free text. */
  constructor(
    readonly code: string,
    readonly detail?: string,
  ) {
    super('AutoConfig request failed');
  }
}
const PATH = /^\/api\/autoconfig(?:\/suggestions|\/[A-Za-z0-9_-]{6,64}(?:\/actions)?)?$/;
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
        if (!PATH.test(path)) throw new AutoHttpError('INVALID');
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
        const detail =
          typeof data?.code === 'string' && /^[A-Z_]{2,40}$/.test(data.code) ? data.code : undefined;
        if (!response.ok)
          throw new AutoHttpError(
            response.status === 401
              ? 'UNAUTHORIZED'
              : response.status === 403
                ? 'FORBIDDEN'
                : response.status === 409
                  ? 'CONFLICT'
                  : (detail ?? 'INVALID'),
            detail,
          );
        return data;
      },
    };
  },
});
