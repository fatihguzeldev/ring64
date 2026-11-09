import {
  using,
  initial,
  snapshot,
  bytes,
  CODE32,
  CODE64,
  equal,
  same,
  preserveNumeric,
  type Scenario,
} from './fixture.js';

export function faultScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'far wide JMP target failure preserves dirty predecessor and entire old context',
      async run() {
        await using(
          compiler,
          'ba7856341248ff2b',
          snapshot(),
          async (cpu) => {
            const numeric = preserveNumeric(cpu);
            const before = cpu.readContext();
            cpu.setState(initial(0x1000n, { 3: 0x6000n, 4: 0x7000n }, 0xcd7n));
            const result = await cpu.run({ budget: 2n });
            equal(result.reason, 'protection-fault', 'wide compatibility JMP');
            equal(result.retired, 1n, 'dirty predecessor retired');
            equal(result.state.registers[2], 0x12345678n, 'live predecessor');
            equal(result.state.registers[4], 0x7000n, 'SP retained');
            equal(result.state.rip, 0x1005n, 'source PC');
            equal(result.state.flags, 0xcd7n, 'FLAGS');
            equal(result.protectionFault?.phase, 'target', 'target phase');
            equal(result.protectionFault?.vector, 13, 'GP');
            equal(result.protectionFault?.errorCode, 0, 'GP0');
            equal(result.protectionFault?.selector, undefined, 'no erroneous selector');
            same(cpu.readContext(), before, 'no context publication');
            numeric();
          },
          {
            data: [
              { base: 0x4010n, bytes: CODE32, write: false },
              { base: 0x6000n, bytes: bytes(0x100002000n, 8) + '1000', write: false },
            ],
          },
        );
      },
    },
    {
      name: 'far CALL preadmits all A and frame writes before publishing any private memory',
      async run() {
        for (const accessedWrite of [false, true])
          await using(
            compiler,
            '48ff1b',
            snapshot(),
            async (cpu) => {
              const numeric = preserveNumeric(cpu);
              const before = cpu.readContext();
              cpu.setState(initial(0x1000n, { 3: 0x6000n, 4: 0x7000n }));
              const result = await cpu.run({ budget: 1n });
              equal(result.retired, 0n, 'failed CALL retirement');
              equal(result.state.registers[4], 0x7000n, 'old SP');
              if (!accessedWrite) {
                equal(result.reason, 'system-memory-fault', 'CS A write before frame permission');
                equal(result.systemMemoryFault?.address, 0x400dn, 'A byte');
                equal(result.systemMemoryFault?.width, 1, 'A width');
                equal(result.systemMemoryFault?.phase, 'descriptor-accessed-write', 'A phase');
                equal(result.fault, undefined, 'no invented stack fault');
              } else {
                equal(result.reason, 'data-fault', 'late frame offset write');
                equal(result.fault?.segment, 'ss', 'implicit stack');
                equal(result.fault?.address, 0x6ff0n, 'second slot');
                equal(result.fault?.width, 8, 'slot width');
                equal(result.fault?.access, 'write', 'write intent');
                equal(result.systemMemoryFault, undefined, 'exclusive fault');
              }
              equal(cpu.readMemory(0x400dn, 1)[0], 0x9a, 'A byte remains uncommitted');
              same(
                cpu.readMemory(0x6ff8n, 8),
                Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
                'first slot remains uncommitted',
              );
              same(cpu.readContext(), before, 'old context');
              numeric();
            },
            {
              data: [
                { base: 0x4008n, bytes: 'ffff0000009aaf00', write: accessedWrite },
                { base: 0x6000n, bytes: bytes(0x2000n, 8) + '0800', write: false },
                { base: 0x6ff8n, bytes: '0102030405060708' },
              ],
            },
          );
      },
    },
    {
      name: 'far explicit FS pointer and implicit SS failures keep distinct source segments',
      async run() {
        for (const pointerPresent of [false, true]) {
          const execution = snapshot();
          execution.segments.fs.base = 0x5000n;
          await using(
            compiler,
            '6448ff1b',
            execution,
            async (cpu) => {
              const numeric = preserveNumeric(cpu);
              cpu.setState(initial(0x1000n, { 3: 0n, 4: 0x7000n }));
              const result = await cpu.run({ budget: 1n });
              equal(result.reason, 'data-fault', 'operand failure');
              equal(result.retired, 0n, 'no retirement');
              equal(result.fault?.segment, pointerPresent ? 'ss' : 'fs', 'correct access owner');
              equal(
                result.fault?.address,
                pointerPresent ? 0x6ff8n : 0x5000n,
                'correct attempted address',
              );
              equal(result.fault?.width, pointerPresent ? 8 : 10, 'actual access span');
              equal(result.fault?.access, pointerPresent ? 'write' : 'read', 'actual access kind');
              equal(result.systemMemoryFault, undefined, 'not descriptor access');
              numeric();
            },
            {
              data: [
                { base: 0x4008n, bytes: CODE64, write: false },
                ...(pointerPresent
                  ? [{ base: 0x5000n, bytes: bytes(0x2000n, 8) + '0800', write: false }]
                  : []),
              ],
            },
          );
        }
      },
    },
    {
      name: 'far gate frontier and return invalid LD do not speculatively probe unselected tails',
      async run() {
        for (const [kind, reason] of [
          [0x0c, 'unsupported'],
          [0x04, 'protection-fault'],
        ] as const)
          await using(
            compiler,
            'ff2b',
            snapshot(),
            async (cpu) => {
              cpu.setState(initial(0x1000n, { 3: 0x6000n, 4: 0x800000000000n }));
              const result = await cpu.run({ budget: 1n });
              equal(result.reason, reason, 'system target classification');
              equal(result.retired, 0n, 'unexecuted handler');
              equal(result.systemMemoryFault, undefined, 'no upper gate read');
              equal(result.fault, undefined, 'no stack probe');
              equal(result.state.registers[4], 0x800000000000n, 'raw SP retained');
            },
            {
              data: [
                {
                  base: 0x4008n,
                  bytes: '0000000000' + kind.toString(16).padStart(2, '0') + '0000',
                  write: false,
                },
                { base: 0x6000n, bytes: bytes(0x2000n, 4) + '0800', write: false },
              ],
            },
          );
        await using(
          compiler,
          '48cb',
          snapshot(),
          async (cpu) => {
            const before = cpu.readContext();
            cpu.setState(initial(0x1000n, { 4: 0x5000n }));
            const result = await cpu.run({ budget: 1n });
            equal(result.reason, 'protection-fault', 'invalid L and D');
            equal(result.protectionFault?.phase, 'descriptor', 'descriptor phase');
            equal(result.protectionFault?.errorCode, 0x18, 'RPL masked');
            equal(result.protectionFault?.selector, 0x1b, 'original selector');
            equal(result.fault, undefined, 'no outer tail read');
            same(cpu.readContext(), before, 'no outer publication');
          },
          {
            data: [
              { base: 0x4018n, bytes: 'ffff0000007bef00', write: false },
              { base: 0x5000n, bytes: bytes(0x2000n, 8) + bytes(0x1bn, 8), write: false },
            ],
          },
        );
      },
    },
  ];
}
