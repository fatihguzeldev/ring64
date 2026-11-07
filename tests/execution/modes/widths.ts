import { changed, context, input, using, type Scenario } from './fixture.js';
import { equal, state } from '../../support/fixture.js';

// Expected words and flags are literal architectural cases. High register banks
// remain sentinels, including the upper half of a legacy 32-bit destination.
export function widthScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'legacy scalar and implicit destinations preserve every bit above their write width',
      run: async () => {
        const profiles = [
          context('protected', false),
          context('protected', true),
          context('compatibility', false),
          context('compatibility', true),
          context('real', false),
          context('real', true),
          context('virtual8086'),
        ];
        for (const execution of profiles)
          for (const width of [16, 32] as const) {
            const wide = width === 32;
            const mask = wide ? 0xffffffffn : 0xffffn;
            const sign = wide ? 0x80000000n : 0x8000n;
            const prefix = execution.segments.cs.default32 === wide ? '' : '66';
            const rows = [
              { code: wide ? 'b878563412' : 'b83412', writes: { 0: wide ? 0x12345678n : 0x1234n } },
              { code: '89d8', writes: { 0: 4n } },
              { code: execution.segments.cs.default32 ? '8d03' : '8d07', writes: { 0: 4n } },
              { code: '21d8', a: 7n, writes: { 0: 4n }, flags: 2n },
              { code: '01d8', writes: { 0: 7n }, flags: 2n },
              { code: '11d8', initialFlags: 3n, writes: { 0: 8n }, flags: 2n },
              { code: '19d8', a: 9n, initialFlags: 3n, writes: { 0: 4n }, flags: 2n },
              { code: 'f7d8', a: 1n, writes: { 0: mask }, flags: 0x97n },
              { code: '40', a: 1n, initialFlags: 3n, writes: { 0: 2n }, flags: 3n },
              { code: 'd1e0', a: 1n, writes: { 0: 2n }, flags: 2n },
              { code: '0fa3d8', a: 16n, writes: {}, flags: 3n },
              { code: '0fb6c3', b: 0x80n, writes: { 0: 0x80n } },
              { code: '0fbec3', b: 0x80n, writes: { 0: wide ? 0xffffff80n : 0xff80n } },
              {
                code: '98',
                a: wide ? 0x8000n : 0x80n,
                writes: { 0: wide ? 0xffff8000n : 0xff80n },
              },
              { code: '99', a: sign, writes: { 2: mask } },
              { code: 'f7e3', writes: { 0: 12n, 2: 0n } },
              { code: '0fafc3', writes: { 0: 12n } },
              { code: 'f7f3', a: 13n, d: 0n, writes: { 0: 3n, 2: 1n } },
              { code: 'f7fb', a: 13n, d: 0n, writes: { 0: 3n, 2: 1n } },
              { code: '0f44c3', initialFlags: 0x42n, writes: { 0: 4n } },
            ];
            for (const row of rows) {
              const code = prefix + row.code;
              await using(compiler, code, execution, async (cpu) => {
                const before = input(0x1000n, {}, row.initialFlags ?? 2n);
                const put = (index: number, value: bigint) => {
                  before.registers[index] = (before.registers[index]! & ~mask) | value;
                };
                put(0, row.a ?? 3n);
                put(3, row.b ?? 4n);
                put(2, row.d ?? 0x55n);
                // LEA must discard high address bits even when the destination is 32-bit.
                if (row.code === '8d03' && wide && !execution.segments.cs.default32)
                  before.registers[3] = 0x1122334400000004n;
                cpu.setState(before);
                const writes: Record<number, bigint> = {};
                for (const [index, word] of Object.entries(row.writes))
                  writes[Number(index)] = (before.registers[Number(index)]! & ~mask) | word;
                const result = await cpu.run({ budget: 1n });
                const label = `${execution.mode}/CS.D${Number(execution.segments.cs.default32)}/${width}/${row.code}`;
                equal(result.reason, 'budget', label);
                equal(result.retired, 1n, label);
                equal(result.remaining, 0n, label);
                equal(result.fault, undefined, label);
                equal(result.segmentFault, undefined, label);
                try {
                  state(
                    result.state,
                    changed(
                      before,
                      0x1000n + BigInt(code.length / 2),
                      writes,
                      row.flags ?? before.flags,
                    ),
                  );
                } catch (cause) {
                  throw new Error(label, { cause });
                }
              });
            }
          }
      },
    },
  ];
}
