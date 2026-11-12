import {
  using,
  snapshot,
  initial,
  equal,
  same,
  delivery,
  type Scenario,
} from '../exception-delivery/fixture.js';

// Intel instruction-reference illegal forms, one row for each Invalid producer family.
const illegal = [
  ['LOCK NOP', 'f090'],
  ['LOCK register ADD', 'f001c0'],
  ['LOCK string', 'f0a4'],
  ['LOCK direction flag', 'f0fc'],
  ['PUSHA long64', '60'],
  ['POPA long64', '61'],
  ['LEA register', '8dc0'],
  ['CMPXCHG8B register', '0fc7c8'],
  ['MASKMOV memory', '0ff703'],
  ['MOVNTQ register', '0fe7c0'],
  ['MOVNTPS register', '0f2bc0'],
  ['MOVNTI register', '0fc3c0'],
  ['LDMXCSR register', '0faed0'],
  ['STMXCSR register', '0faed8'],
  ['INTO long64', 'ce'],
  ['far immediate long64', 'ea'],
  ['far CALL register', 'ffd8'],
  ['MOV reserved segment', '8ef0'],
  ['MOV CS', '8ec8'],
  ['LSS register', '0fb2c0'],
  ['POP SS long64', '17'],
  ['MOVMSKPS memory', '0f5003'],
  ['MOVLPS store register', '0f13c0'],
  ['FXSAVE register', '0faec0'],
  ['PEXTRW MMX memory', '0fc50300'],
  ['PMOVMSKB MMX memory', '0fd703'],
  ['MOVDQ2Q memory', 'f20fd603'],
] as const;

export function decodeScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...illegal.map(([name, code]): Scenario => ({
      name: `architectural access #UD ${name} has a literal illegal-form oracle`,
      async run() {
        await using(
          compiler,
          code,
          snapshot(),
          async (cpu) => {
            cpu.setState(initial(0x1000n, {}, 0x10202n));
            const report = await cpu.run({ budget: 1n });
            equal(report.reason, 'invalid-encoding', 'inherited report');
            equal(report.state.flags, 0x10202n, 'report retains pre-begin RF');
            const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
            delivery(result, 'event-budget', 0n, 0n, 0n);
            equal(result.state.flags, 0x202n, 'selected decode begin clears live RF');
            same(
              result.state.event,
              {
                kind: 'pending',
                exception: {
                  vector: 6,
                  instructionPc: 0x1000n,
                  returnPc: 0x1000n,
                  savedFlags: 0x10202n,
                },
              },
              'no #UD error-code slot',
            );
            equal(result.resources.compilations, 0, 'fault precedes artifact admission');
          },
          { limits: { maxArtifactBytes: 1 } },
        );
      },
    })),
    {
      name: 'architectural access length required-byte and unsupported frontiers stay distinct',
      async run() {
        for (const [code, reason, vector] of [
          ['66'.repeat(14) + '90', 'budget', 0],
          ['66'.repeat(15), 'event-budget', 13],
          ['66'.repeat(14) + 'b8', 'event-budget', 13],
          ['66'.repeat(14), 'fetch-fault', 0],
          ['82', 'unsupported', 0],
          ['0f33', 'unsupported', 0],
          ['f0f090', 'unsupported', 0],
          ['c8000000', 'unsupported', 0],
        ] as const)
          await using(compiler, code, snapshot(), async (cpu) => {
            cpu.setState(initial(0x1000n, {}, 0x10202n));
            const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
            equal(result.reason, reason, code);
            if (vector)
              same(
                result.state.event,
                {
                  kind: 'pending',
                  exception: {
                    vector,
                    instructionPc: 0x1000n,
                    returnPc: 0x1000n,
                    savedFlags: 0x10202n,
                    errorCode: 0,
                  },
                },
                'length #GP0',
              );
            else same(result.state.event, { kind: 'ready' }, 'no fabricated source');
          });
      },
    },
    {
      name: 'architectural access mode-illegal ARPL and descriptor operations retain real-mode #UD',
      async run() {
        for (const code of ['63c0', '0f00c0', '0f02c0'])
          await using(compiler, code, snapshot('real'), async (cpu) => {
            cpu.setState(initial());
            const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
            equal(result.reason, 'event-budget', 'recognized illegal real-mode form');
            equal(
              result.state.event.kind === 'pending' && result.state.event.exception.vector,
              6,
              'mode #UD',
            );
          });
      },
    },
  ];
}
