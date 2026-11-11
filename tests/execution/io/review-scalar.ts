import { createCpu } from '../../../host/index.js';
import { LIMITS, equal, hex, initial, type Scenario } from '../../support/fixture.js';
import { profiles, same } from '../far-control/fixture.js';

export function ioScalarReviewScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'scalar port opcode matrix preserves parent banks across fourteen imported profiles',
      async run() {
        for (const context of profiles())
          for (const width of [8, 16, 32] as const)
            for (const input of [false, true])
              for (const immediate of [false, true]) {
                const normal32 = context.mode === 'long64' || context.segments.cs.default32;
                const prefix = width === 8 ? '66' : (width === 32) !== normal32 ? '66' : '';
                const opcode = input
                  ? immediate
                    ? width === 8
                      ? 'e4'
                      : 'e5'
                    : width === 8
                      ? 'ec'
                      : 'ed'
                  : immediate
                    ? width === 8
                      ? 'e6'
                      : 'e7'
                    : width === 8
                      ? 'ee'
                      : 'ef';
                const code = prefix + opcode + (immediate ? '80' : '');
                const tss = new Uint8Array(0x2081);
                tss[0x66] = 0x80;
                tss[0x2080] = 0xff;
                context.tr = {
                  selector: 0x28,
                  valid: true,
                  base: 0x6000n,
                  limit: 0x2080,
                  attributes: 0x8b,
                };
                const value = width === 8 ? 0xab : width === 16 ? 0xbeef : 0x89abcdef;
                const before = initial(
                  0x1000n,
                  { 0: 0x1122334455667788n, 2: 0xffff000000001234n },
                  0x108d7n,
                );
                const mask = (1n << BigInt(width)) - 1n;
                const trace: string[] = [];
                const cpu = await createCpu({
                  compiler,
                  limits: LIMITS,
                  context,
                  code: { base: 0x1000n, bytes: hex(code) },
                  ram: { base: 0x6000n, bytes: tss },
                  io: {
                    read(port, bits) {
                      trace.push(`r:${port}:${bits}`);
                      return value;
                    },
                    write(port, bits, actual) {
                      trace.push(`w:${port}:${bits}:${actual}`);
                    },
                  },
                });
                try {
                  cpu.setState(before);
                  const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
                  equal(result.reason, 'budget', `${context.mode}/${width}/${input}/${immediate}`);
                  equal(result.retired, 1n, 'scalar retirement');
                  equal(result.repeatIterations, 0n, 'no scalar repeat charge');
                  equal(result.state.rip, 0x1000n + BigInt(code.length / 2), 'exact bytes');
                  equal(result.state.flags, 0x8d7n, 'only begin RF clears');
                  const expected = input
                    ? width === 32 && context.mode === 'long64'
                      ? BigInt(value)
                      : (before.registers[0]! & ~mask) | BigInt(value)
                    : before.registers[0]!;
                  equal(result.state.registers[0], expected, 'input parent merge');
                  same(
                    result.state.registers.slice(1),
                    before.registers.slice(1),
                    'no other register changes',
                  );
                  same(
                    trace,
                    [
                      input
                        ? `r:${immediate ? 0x80 : 0x1234}:${width}`
                        : `w:${immediate ? 0x80 : 0x1234}:${width}:${Number(before.registers[0]! & mask)}`,
                    ],
                    'one full-width captured transaction',
                  );
                } finally {
                  cpu.dispose();
                }
              }
      },
    },
    {
      name: 'scalar port REX prefixes never select wide IO or extended implicit registers',
      async run() {
        for (const [code, input, width] of [
          ['48ed', true, 32],
          ['6648ed', true, 16],
          ['48ef', false, 32],
          ['6648ef', false, 16],
          ['4fec', true, 8],
          ['66674fed', true, 16],
        ] as const) {
          const trace: string[] = [];
          const value = width === 8 ? 0xab : width === 16 ? 0xbeef : 0x89abcdef;
          const cpu = await createCpu({
            compiler,
            limits: LIMITS,
            code: { base: 0x1000n, bytes: hex(code) },
            ram: { base: 0x4000n, bytes: new Uint8Array(1) },
            io: {
              read(port, bits) {
                trace.push(`${port}:${bits}`);
                return value;
              },
              write(port, bits) {
                trace.push(`${port}:${bits}`);
              },
            },
          });
          try {
            const before = initial(0x1000n, {
              0: 0x1122334455667788n,
              2: 0x8000000000001234n,
              8: 0xfeedn,
            });
            cpu.setState(before);
            const result = await cpu.run({ budget: 1n });
            equal(result.retired, 1n, 'one scalar IO');
            same(trace, [`4660:${width}`], 'ignored REX.W/extensions');
            equal(result.state.registers[8], 0xfeedn, 'R8 untouched');
            if (input) {
              const mask = (1n << BigInt(width)) - 1n;
              equal(
                result.state.registers[0],
                width === 32 ? BigInt(value) : (before.registers[0]! & ~mask) | BigInt(value),
                'selected parent write',
              );
            }
          } finally {
            cpu.dispose();
          }
        }
      },
    },
    {
      name: 'port required immediate fetch precedes LOCK UD while unsupported repeat stops before an unrelated tail',
      async run() {
        for (const [code, reason, address] of [
          ['f0e4', 'fetch-fault', 0x1002n],
          ['f0e480', 'invalid-encoding', undefined],
          ['f3e4', 'unsupported', undefined],
          ['f26c', 'unsupported', undefined],
        ] as const) {
          let calls = 0;
          const cpu = await createCpu({
            compiler,
            limits: LIMITS,
            code: { base: 0x1000n, bytes: hex(code) },
            ram: { base: 0x4000n, bytes: new Uint8Array(1) },
            io: {
              read() {
                calls++;
                return 1;
              },
              write() {
                calls++;
              },
            },
          });
          try {
            const before = initial(0x1000n, {}, 0x10002n);
            cpu.setState(before);
            const result = await cpu.run({ budget: 1n });
            equal(result.reason, reason, 'literal legality phase');
            equal(calls, 0, 'no invalid-form effect');
            equal(result.retired, 0n, 'no invalid-form retirement');
            same(result.state.registers, before.registers, 'no operand state');
            equal(result.state.flags, 0x10002n, 'pre-begin report RF');
            equal(result.fault?.address, address, 'only required immediate fetch fault');
          } finally {
            cpu.dispose();
          }
        }
      },
    },
  ];
}
