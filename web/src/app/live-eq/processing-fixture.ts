/** Deterministic test data, never used by the production panel. */
export const processingFixture = (channel = 3, serverId = 'srv-1') => ({
  schemaVersion: 1,
  serverId,
  channel,
  connection: { generation: 7, link: 'READY' },
  parameters: Object.fromEntries([
    ...[1, 2, 3, 4].flatMap((b) =>
      [
        ['freq', b === 4 ? 6640 : 1000],
        ['gain', b === 4 ? -1 : 0],
        ['q', 1],
      ].map(([f, value]) => [
        `ch.${channel}.eq.b${b}.${f}`,
        {
          display: {
            state: 'confirmed',
            source: 'independent_socket_input',
            value,
            ageMs: 0,
            freshnessMs: 3000,
            generation: 7,
            connectionCurrent: true,
          },
        },
      ]),
    ),
    [
      `ch.${channel}.eq.hpf.freq`,
      {
        display: {
          state: 'confirmed',
          source: 'independent_socket_input',
          value: 98,
          rawValue: 0.25,
          ageMs: 0,
          freshnessMs: 3000,
          generation: 7,
          connectionCurrent: true,
        },
      },
    ],
    [
      `ch.${channel}.eq.bypass`,
      {
        display: {
          state: 'confirmed',
          source: 'independent_socket_input',
          value: false,
          ageMs: 0,
          freshnessMs: 3000,
          generation: 7,
          connectionCurrent: true,
        },
      },
    ],
  ]),
});
