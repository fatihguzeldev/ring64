import {
  changed,
  check,
  equal,
  hex,
  initial,
  snapshot,
  state,
  using,
  type Scenario,
} from './fixture.js';

function projection(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) =>
    typeof item === 'bigint' ? item.toString(16) : item,
  );
}

export function queryScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'protection query partial destination uses dirty live upper bits and preserves numeric state',
      async run() {
        for (const mode of ['protected', 'compatibility', 'long64'] as const) {
          const code = mode === 'long64' ? '48ffc0660f02c3' : '40660f02c3';
          await using(
            compiler,
            code,
            snapshot(mode),
            async (cpu) => {
              const pending = cpu.readX87State();
              pending.controlWord = 0x37b;
              pending.statusWord = 0x8084;
              pending.registers = Array.from({ length: 8 }, (_, i) => (0xffffn << 64n) | BigInt(i));
              cpu.setX87State(pending);
              cpu.setXmmState(
                Array.from({ length: 16 }, (_, i) => 0x123456789abcdef0n + BigInt(i)),
              );
              cpu.setMxcsr(0x7fa5);
              const numeric = projection([cpu.readX87State(), cpu.readXmmState(), cpu.readMxcsr()]);
              const before = projection(cpu.readContext());
              const input = initial(0x1000n, { 0: 0x112233445566ffffn, 3: 8n }, 0xcd7n);
              for (let attempt = 0; attempt < 2; attempt++) {
                cpu.setState(input);
                const result = await cpu.run({ budget: 2n });
                equal(result.reason, 'budget', `${mode} query completion`);
                equal(result.retired, 2n, 'producer and query retire once');
                state(
                  result.state,
                  changed(
                    input,
                    BigInt(0x1000 + code.length / 2),
                    { 0: 0x1122334455679a00n },
                    0x457n,
                  ),
                );
                equal(result.resources.dispatches, 0, 'query retains context');
                equal(result.resources.compilations, attempt === 0 ? 1 : 0, 'query owner reused');
                equal(result.protectionFault, undefined, 'no selector fault');
                equal(result.systemMemoryFault, undefined, 'no internal fault');
                equal(projection(cpu.readContext()), before, 'query never reloads a cache');
                equal(
                  projection([cpu.readX87State(), cpu.readXmmState(), cpu.readMxcsr()]),
                  numeric,
                  'numeric projections preserved',
                );
                equal(
                  [...cpu.readMemory(0x4008n, 8)].join(','),
                  [...hex('56340000349aca12')].join(','),
                  'query never sets clear A',
                );
              }
            },
            { data: [{ base: 0x4008n, bytes: '56340000349aca12', write: false }] },
          );
        }
      },
    },
    {
      name: 'protection public query type tables ignore P and exempt both privilege comparisons for conforming code',
      async run() {
        for (const mode of ['protected', 'long64'] as const) {
          for (const packet of [
            {
              bytes: 'ffff0000000c0000',
              cpl: 0,
              selector: 8n,
              lar: 0xc00,
              lsl: undefined,
              verr: false,
              verw: false,
            },
            {
              bytes: 'ffff000000010000',
              cpl: 0,
              selector: 8n,
              lar: mode === 'protected' ? 0x100 : undefined,
              lsl: mode === 'protected' ? 0xffff : undefined,
              verr: false,
              verw: false,
            },
            {
              bytes: '56340000341eca12',
              cpl: 3,
              selector: 11n,
              lar: 0xc01e00,
              lsl: 0xa3456fff,
              verr: true,
              verw: false,
            },
            {
              bytes: 'ffff000000120000',
              cpl: 0,
              selector: 11n,
              lar: undefined,
              lsl: undefined,
              verr: false,
              verw: false,
            },
            {
              bytes: 'ffff000000720000',
              cpl: 3,
              selector: 11n,
              lar: 0x7200,
              lsl: 0xffff,
              verr: true,
              verw: true,
            },
          ]) {
            await using(
              compiler,
              '0f02c30f03d30f00e30f00eb',
              snapshot(mode, packet.cpl),
              async (cpu) => {
                const before = projection(cpu.readContext());
                let expected = initial(
                  0x1000n,
                  { 0: 0xaabbccdd12345678n, 2: 0x1122334487654321n, 3: packet.selector },
                  0xcd7n,
                );
                cpu.setState(expected);
                for (const operation of [
                  { register: 0, value: packet.lar, success: packet.lar !== undefined },
                  { register: 2, value: packet.lsl, success: packet.lsl !== undefined },
                  { register: undefined, value: undefined, success: packet.verr },
                  { register: undefined, value: undefined, success: packet.verw },
                ]) {
                  const writes: Record<number, bigint> = {};
                  if (operation.register !== undefined && operation.value !== undefined) {
                    writes[operation.register] =
                      BigInt(operation.value) |
                      (mode === 'long64'
                        ? 0n
                        : expected.registers[operation.register]! & 0xffffffff00000000n);
                  }
                  expected = changed(
                    expected,
                    expected.rip + 3n,
                    writes,
                    (expected.flags & ~0x40n) | (operation.success ? 0x40n : 0n),
                  );
                  const result = await cpu.run({ budget: 1n });
                  equal(
                    result.reason,
                    'budget',
                    'query completes without descriptor-load exception',
                  );
                  equal(result.retired, 1n, 'one query');
                  state(result.state, expected);
                  equal(result.resources.dispatches, 0, 'no query context change');
                  equal(result.protectionFault, undefined, 'P is not a load check');
                  equal(result.systemMemoryFault, undefined, 'no rejected-type tail probe');
                }
                equal(projection(cpu.readContext()), before, 'queries preserve all context fields');
                equal(
                  [...cpu.readMemory(0x4008n, 8)].join(','),
                  [...hex(packet.bytes)].join(','),
                  'query bytes preserved',
                );
              },
              { data: [{ base: 0x4008n, bytes: packet.bytes, write: false }] },
            );
          }
        }
      },
    },
    {
      name: 'protection LSL low read and type checks precede system tail while LAR stays eight bytes',
      async run() {
        for (const packet of [
          {
            code: '0f03c3',
            bytes: '3412000000800000',
            limit: 31,
            fault: undefined,
            value: undefined,
          },
          {
            code: '0f03c3',
            bytes: '3412000000020000',
            limit: 15,
            fault: undefined,
            value: undefined,
          },
          {
            code: '0f03c3',
            bytes: '3412000000020000',
            limit: 31,
            fault: 0x4010n,
            value: undefined,
          },
          { code: '0f03c3', bytes: undefined, limit: 15, fault: 0x4008n, value: undefined },
          { code: '0f02c3', bytes: '3412000000020000', limit: 31, fault: undefined, value: 0x200n },
        ]) {
          const execution = snapshot();
          execution.gdtr.limit = packet.limit;
          await using(
            compiler,
            packet.code,
            execution,
            async (cpu) => {
              const input = initial(0x1000n, { 0: 0xaabbccdddeadbeefn, 3: 8n }, 0xcd7n);
              cpu.setState(input);
              const before = projection(cpu.readContext());
              const result = await cpu.run({ budget: 1n });
              if (packet.fault !== undefined) {
                equal(result.reason, 'system-memory-fault', 'required descriptor slice');
                equal(result.retired, 0n, 'failed query does not retire');
                state(result.state, input);
                equal(result.systemMemoryFault?.address, packet.fault, 'actual slice address');
                equal(
                  result.systemMemoryFault?.failingAddress,
                  packet.fault,
                  'first inaccessible byte',
                );
                equal(result.systemMemoryFault?.width, 8, 'actual low or upper slice');
                equal(result.systemMemoryFault?.phase, 'descriptor-read', 'internal phase');
                check(result.systemMemoryFault?.table === 'gdt', 'root');
                equal(result.systemMemoryFault?.selector, 8, 'original selector');
              } else {
                equal(result.reason, 'budget', 'failed selector is a query result');
                equal(result.retired, 1n, 'query retires');
                state(
                  result.state,
                  changed(
                    input,
                    0x1003n,
                    packet.value === undefined ? {} : { 0: packet.value },
                    packet.value === undefined ? 0xc97n : 0xcd7n,
                  ),
                );
                equal(result.systemMemoryFault, undefined, 'no unused tail access');
              }
              equal(result.protectionFault, undefined, 'query does not raise selector protection');
              equal(result.fault, undefined, 'internal access is not explicit DS');
              equal(projection(cpu.readContext()), before, 'query fault preserves caches');
            },
            {
              data:
                packet.bytes === undefined
                  ? []
                  : [{ base: 0x4008n, bytes: packet.bytes, write: false }],
            },
          );
        }
      },
    },
    {
      name: 'protection extended LLDT publishes high base and ignores reserved fields before SLDT readback',
      async run() {
        for (const mode of ['compatibility', 'long64'] as const) {
          await using(
            compiler,
            '0f00d30f00c0',
            snapshot(mode),
            async (cpu) => {
              const input = initial(
                0x1000n,
                { 0: 0xaabbccdddeadbeefn, 3: 0x112233440000000bn },
                0xcd7n,
              );
              cpu.setState(input);
              const result = await cpu.run({ budget: 2n });
              equal(result.reason, 'budget', 'LLDT and SLDT complete');
              equal(result.retired, 2n, 'one retirement per operation');
              state(
                result.state,
                changed(input, 0x1006n, { 0: mode === 'long64' ? 11n : 0xaabbccdd0000000bn }),
              );
              equal(result.resources.dispatches, 1, 'one context replacement');
              const ldt = cpu.readContext().ldtr;
              equal(ldt.selector, 11, 'original RPL retained');
              equal(ldt.valid, true, 'valid LDT');
              equal(ldt.base, 0x100005000n, 'full extended base');
              equal(ldt.limit, 0x17, 'effective limit');
              equal(ldt.attributes, 0x82, 'captured attributes');
              equal(result.protectionFault, undefined, 'ignored upper fields accepted');
              equal(result.systemMemoryFault, undefined, 'complete system descriptor');
            },
            { data: [{ base: 0x4008n, bytes: '170000500082000001000000ffe0ffff', write: false }] },
          );
        }
      },
    },
    {
      name: 'protection LLDT validates type and presence before tail and reports exact selector error phases',
      async run() {
        for (const packet of [
          { bytes: '1700005000920000', limit: 31, selector: 11n, vector: 13, phase: 'descriptor' },
          { bytes: '1700005000020000', limit: 31, selector: 11n, vector: 11, phase: 'descriptor' },
          {
            bytes: '170000500082000001000000fff0ffff',
            limit: 31,
            selector: 11n,
            vector: 13,
            phase: 'descriptor',
          },
          {
            bytes: '170000500082000000800000ffe0ffff',
            limit: 31,
            selector: 11n,
            vector: 13,
            phase: 'descriptor',
          },
          { bytes: undefined, limit: 15, selector: 11n, vector: 13, phase: 'selector' },
          { bytes: undefined, limit: 31, selector: 15n, vector: 13, phase: 'selector' },
        ]) {
          const execution = snapshot();
          execution.gdtr.limit = packet.limit;
          execution.ldtr = {
            selector: 0x18,
            valid: true,
            base: 0x6000n,
            limit: 0xffff,
            attributes: 0x82,
          };
          await using(
            compiler,
            '0f00d3',
            execution,
            async (cpu) => {
              const input = initial(0x1000n, { 3: packet.selector }, 0xcd7n);
              cpu.setState(input);
              const before = projection(cpu.readContext());
              const result = await cpu.run({ budget: 1n });
              equal(result.reason, 'protection-fault', 'LLDT rejection');
              equal(result.retired, 0n, 'no failed retirement');
              state(result.state, input);
              equal(result.protectionFault?.vector, packet.vector, 'GP or NP');
              equal(
                result.protectionFault?.errorCode,
                Number(packet.selector & 0xfffcn),
                'index/TI without RPL',
              );
              equal(result.protectionFault?.selector, Number(packet.selector), 'original selector');
              equal(result.protectionFault?.phase, packet.phase, 'failed phase');
              equal(result.systemMemoryFault, undefined, 'no premature tail probe');
              equal(result.fault, undefined, 'no explicit register-source fault');
              equal(projection(cpu.readContext()), before, 'old loaded LDT retained');
            },
            {
              data:
                packet.bytes === undefined
                  ? []
                  : [{ base: 0x4008n, bytes: packet.bytes, write: false }],
            },
          );
        }
      },
    },
  ];
}
