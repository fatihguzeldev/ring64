import {
  using,
  snapshot,
  initial,
  outcome,
  equal,
  same,
  hex,
  CODE64,
  preserveNumeric,
  type Scenario,
} from './fixture.js';

export function preservationScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'system flags survive every inherited scalar producer class and live memory helpers',
      async run() {
        const cases: {
          code: string;
          changed?: Record<number, bigint>;
          input?: Record<number, bigint>;
          memory?: string;
          full?: boolean;
        }[] = [
          { code: 'b805000000', changed: { 0: 5n }, full: true },
          { code: '83c001', changed: { 0: 2n } },
          { code: '31c0', changed: { 0: 0n } },
          { code: '83d001', changed: { 0: 3n } },
          { code: '83d801', changed: { 0: 0xffffffffn } },
          { code: 'ffc0', changed: { 0: 2n } },
          { code: 'ffc8', changed: { 0: 0n } },
          { code: 'f7d8', changed: { 0: 0xffffffffn } },
          { code: 'f7d0', changed: { 0: 0xfffffffen }, full: true },
          { code: 'd1e0', changed: { 0: 2n } },
          { code: 'd1c0', changed: { 0: 2n } },
          { code: 'd3e0', input: { 1: 0n }, full: true },
          { code: '0fbae000' },
          { code: '0fbae801', changed: { 0: 3n } },
          { code: '0fbcc8', changed: { 1: 0n } },
          { code: '0fbdc8', changed: { 1: 0n } },
          { code: '0fafc1', changed: { 0: 2n } },
          { code: 'f7e1', changed: { 0: 2n } },
          { code: 'f7f1', changed: { 0: 0n, 2: 1n } },
          { code: '0fc1c8', changed: { 0: 3n, 1: 1n } },
          { code: '0fb1d1', changed: { 0: 2n } },
          { code: '91', changed: { 0: 2n, 1: 1n }, full: true },
          { code: '9f', changed: { 0: 0xd701n }, full: true },
          { code: '9e' },
          { code: '0f02c1', input: { 1: 8n }, changed: { 0: 0x00a09b00n } },
          { code: 'f0830301', memory: '02000000' },
          { code: '0f44c1', changed: { 0: 2n }, full: true },
          { code: '0f95c0', changed: { 0: 0n }, full: true },
          { code: '488d4304', changed: { 0: 0x6004n }, full: true },
        ];
        for (const packet of cases) {
          await using(
            compiler,
            packet.code,
            snapshot(),
            async (cpu) => {
              const numeric = preserveNumeric(cpu);
              const before = initial(
                0x1000n,
                { 0: 1n, 1: 2n, 2: 0n, 3: 0x6000n, ...packet.input },
                0x3c7ed7n,
              );
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
              outcome(result, 'budget', 1n, 1n, 0n);
              equal(result.state.flags & ~0x8d5n, 0x3c7602n, `all control/DF bits ${packet.code}`);
              if (packet.full)
                equal(result.state.flags, before.flags, 'nonproducer retains full flags');
              const expected = before.registers.slice();
              for (const [bank, value] of Object.entries(packet.changed ?? {}))
                expected[Number(bank)] = value;
              same(result.state.registers, expected, `whole banks ${packet.code}`);
              equal(
                result.state.rip,
                0x1000n + BigInt(packet.code.length / 2),
                'whole selected instruction',
              );
              same(
                cpu.readMemory(0x6000n, 4),
                hex(packet.memory ?? '01000000'),
                'ordinary memory result',
              );
              numeric();
            },
            {
              data: [
                { base: 0x4008n, bytes: CODE64, write: false },
                { base: 0x6000n, bytes: '01000000' },
              ],
            },
          );
        }
      },
    },
  ];
}
