import { expect, it, vi } from 'vitest';
import { evaluateObserverRoute, type WindowsRouteSnapshot } from '../src/mixer/observer-route.js';
import { runRoutePreflight } from '../src/f0-route-preflight-cli.js';
import { routeFixture } from './support/route-fixtures.js';
// Casos do self-test F0D antigo, agora no único algoritmo TS usado em produção.
it.each([
  ['wifi', '10.10.1.1', 8], ['ethernet', '192.168.50.10', 9],
] as const)('aprova %s on-link com internet independente via tether', (mode, ip, index) => {
  const snapshot = routeFixture(); snapshot.selected = [{ InterfaceIndex: index }];
  expect(evaluateObserverRoute(snapshot, ip, mode, index)).toMatchObject({ passed: true, reason: 'ok', selectedInterfaceIndex: index });
});
const cases: Array<[string, (s: WindowsRouteSnapshot) => void, string]> = [
  ['tether como rota', s => { s.selected = [{ InterfaceIndex: 10 }]; }, 'route_via_usb_tether'],
  ['outra NIC', s => { s.selected = [{ InterfaceIndex: 9 }]; }, 'unexpected_interface'],
  ['outra classe', s => { s.adapters[0]!.Medium = 14; }, 'transport_mismatch'],
  ['classe desconhecida', s => { s.adapters[0]!.Medium = 0; }, 'transport_mismatch'],
  ['tether disfarçado no próprio índice', s => { s.adapters[0]!.UsbTether = true; }, 'route_via_usb_tether'],
  ['NIC down', s => { s.adapters[0]!.Up = false; }, 'interface_down'],
  ['fora da sub-rede', s => { s.addresses[0]!.IPAddress = '10.10.2.20'; }, 'target_not_on_link'],
  ['overlap de sub-redes', s => { s.addresses[2]!.IPAddress = '10.10.1.21'; }, 'overlapping_subnets'],
  ['custos iguais', s => { s.routes.push({ InterfaceIndex: 10, DestinationPrefix: '10.10.1.0/24', RouteMetric: 10 }); }, 'ambiguous_routes'],
  ['Find-NetRoute contradiz métricas', s => { s.routes.push({ InterfaceIndex: 10, DestinationPrefix: '10.10.1.0/24', RouteMetric: 0 }); }, 'snapshot_incomplete'],
  ['sem métrica', s => { s.interfaces = s.interfaces.filter(i => i.InterfaceIndex !== 10); }, 'snapshot_incomplete'],
  ['sem rotas', s => { s.routes = []; }, 'snapshot_incomplete'],
  ['índice desconhecido', s => { s.selected = [{ InterfaceIndex: 42 }]; }, 'snapshot_incomplete'],
  ['escolha incoerente', s => { s.selected[1]!.InterfaceIndex = 9; }, 'snapshot_incomplete'],
  ['índices duplicados', s => { s.adapters.push(s.adapters[0]!); }, 'snapshot_incomplete'],
  ['métricas duplicadas', s => { s.interfaces.push(s.interfaces[0]!); }, 'snapshot_incomplete'],
];
it.each(cases)('recusa %s sem expor topologia', (_, mutate, reason) => {
  const s = routeFixture(); mutate(s);
  const decision = evaluateObserverRoute(s, '10.10.1.1', 'wifi', 8);
  expect(decision).toMatchObject({ passed: false, reason });
  expect(JSON.stringify(decision)).not.toMatch(/10\.10\.|192\.168|IPAddress|DestinationPrefix|MAC|SSID/);
});
it('compara prefixo antes do custo e soma métrica de rota e interface', () => {
  const s = routeFixture(); s.routes[0]!.RouteMetric = 4000;
  expect(evaluateObserverRoute(s, '10.10.1.1', 'wifi', 8).passed).toBe(true);
});
it('aceita /32 corretamente; recusa IP público e schema inválido', () => {
  const s = routeFixture(); s.addresses[0]!.PrefixLength = 32;
  expect(evaluateObserverRoute(s, '10.10.1.20', 'wifi', 8).passed).toBe(true);
  expect(evaluateObserverRoute(s, '10.10.1.1', 'wifi', 8).reason).toBe('target_not_on_link');
  expect(evaluateObserverRoute(s, '8.8.8.8', 'wifi', 8).reason).toBe('invalid_target');
  s.routes[0]!.DestinationPrefix = '10.10.1.0/33';
  expect(evaluateObserverRoute(s, '10.10.1.20', 'wifi', 8).reason).toBe('snapshot_incomplete');
});
it('CLI usa o mesmo avaliador e exporta somente decisão; falhas não vazam erro privado', () => {
  const write = vi.fn(), query = vi.fn((ip, transport, index) => evaluateObserverRoute(routeFixture(), ip, transport, index));
  expect(runRoutePreflight(['--ip', '10.10.1.1', '--transport', 'wifi', '--interface-index', '8'], { write, query })).toBe(0);
  expect(JSON.parse(write.mock.calls[0]![0])).toMatchObject({ passed: true, transport: 'wifi' });
  expect(write.mock.calls.flat().join('')).not.toContain('10.10.1.1');
  for (const args of [[], ['--ip', '10.10.1.1'], ['--help', '--ip'], ['--ip', 'bad; code'], ['--ip', '10.10.1.1', '--transport', 'auto', '--interface-index', '8']]) {
    expect(runRoutePreflight(args, { write, query })).toBe(1);
  }
  expect(query).toHaveBeenCalledTimes(1);
  expect(runRoutePreflight(['--ip', '10.10.1.1', '--transport', 'wifi', '--interface-index', '8'], { write, query: () => { throw new Error('SECRET network policy'); } })).toBe(1);
  expect(write.mock.calls.flat().join('')).not.toContain('SECRET');
});
