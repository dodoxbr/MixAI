import type { WindowsRouteSnapshot } from '../../src/mixer/observer-route.js';
/** RFC1918 fictício; nenhum endereço é consultado por estes testes. */
export function routeFixture(): WindowsRouteSnapshot {
  return {
    interfaces: [{ InterfaceIndex: 8, InterfaceMetric: 20 }, { InterfaceIndex: 9, InterfaceMetric: 20 }, { InterfaceIndex: 10, InterfaceMetric: 10 }],
    adapters: [
      { ifIndex: 8, Up: true, Medium: 9, Hardware: true, UsbTether: false },
      { ifIndex: 9, Up: true, Medium: 14, Hardware: true, UsbTether: false },
      { ifIndex: 10, Up: true, Medium: 14, Hardware: true, UsbTether: true },
    ],
    addresses: [
      { InterfaceIndex: 8, IPAddress: '10.10.1.20', PrefixLength: 24 },
      { InterfaceIndex: 9, IPAddress: '192.168.50.20', PrefixLength: 24 },
      { InterfaceIndex: 10, IPAddress: '192.168.42.20', PrefixLength: 24 },
    ],
    routes: [
      { InterfaceIndex: 8, DestinationPrefix: '10.10.1.0/24', RouteMetric: 0 },
      { InterfaceIndex: 9, DestinationPrefix: '192.168.50.0/24', RouteMetric: 0 },
      { InterfaceIndex: 10, DestinationPrefix: '0.0.0.0/0', RouteMetric: 0 },
    ],
    selected: [{ InterfaceIndex: 8 }, { InterfaceIndex: 8 }],
  };
}
