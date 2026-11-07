import { expect, it } from 'vitest';
import { diagnosticsContainSecret } from './support/log-secrets.js';
const secrets = ['1357', 'fixture-token-readonly'];
it('ignora coincidência em timestamp/métrica numéricos do Caddy, incluindo incidente #42', () => {
  const log = [
    { level: 'info', ts: 1794013423.2513578, msg: 'cleaning storage unit' },
    { level: 'info', ts: 1357, GOMEMLIMIT: 1357000000, previous: 9223372036854775000, msg: 'ready' },
  ].map(x => JSON.stringify(x)).join('\n');
  expect(diagnosticsContainSecret(log, secrets)).toBe(false);
});
it.each([
  '{"msg":"PIN=1357"}',
  '{"request":{"body":{"pin":1357}}}',
  '{"request":{"headers":{"Authorization":["Bearer fixture-token-readonly"]}}}',
  '{"request":{"uri":"/api/login?pin=1357"}}',
  '{"body":"{\\"pin\\":\\"1357\\"}"}',
  '{"body":"\\u0031\\u0033\\u0035\\u0037"}',
  '{"ts":"1794013423.2513578"}',
  '{"1357":"unexpected key"}',
  '{"values":[1357,"other"]}',
  'unstructured PIN=1357',
  '{"malformed":"fixture-token-readonly',
])('preserva detecção de vazamento em %s', line => {
  expect(diagnosticsContainSecret(line, secrets)).toBe(true);
});
it('não perde vazamento depois de linhas JSON válidas/inválidas e CRLF', () => {
  expect(diagnosticsContainSecret('{"ts":1794013423.2513578}\r\nready\r\n{"nested":{"token":"fixture-token-readonly"}}', secrets)).toBe(true);
  expect(diagnosticsContainSecret('{"msg":"normal","count":42}\r\nready', secrets)).toBe(false);
});
