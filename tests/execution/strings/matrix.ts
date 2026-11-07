import { memory } from '../../support/fixture.js';
import { LONG, changed, context, input, outcome, using, type Scenario } from './fixture.js';

const widths = [
  {
    bits: 8,
    load: '7b',
    accumulator: '88',
    scan: '89',
    unequal: '7c',
    loaded: 0x112233445566777bn,
  },
  {
    bits: 16,
    load: '7b00',
    accumulator: '8877',
    scan: '8977',
    unequal: '7c00',
    loaded: 0x112233445566007bn,
  },
  {
    bits: 32,
    load: '7b000000',
    accumulator: '88776655',
    scan: '89776655',
    unequal: '7c000000',
    loaded: 0x112233440000007bn,
  },
  {
    bits: 64,
    load: '7b00000000000000',
    accumulator: '8877665544332211',
    scan: '8977665544332211',
    unequal: '7c00000000000000',
    loaded: 0x7bn,
  },
] as const;

function patch(frame: string, at: number, bytes: string): string {
  return frame.slice(0, 2 * at) + bytes + frame.slice(2 * at + bytes.length);
}

export function matrixScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'string family matrix preserves all banks across imported modes sizes directions and repeat forms',
      async run() {
        const modes = [
          { execution: LONG, default32: true, long64: true },
          ...(['real', 'protected', 'compatibility'] as const).flatMap((mode) =>
            [false, true].map((default32) => ({
              execution: context(mode, default32, !default32),
              default32,
              long64: false,
            })),
          ),
          { execution: context('virtual8086', false, false), default32: false, long64: false },
        ];
        for (const mode of modes)
          for (const row of widths.filter((row) => mode.long64 || row.bits !== 64))
            for (const address of mode.long64 ? [64, 32] : [16, 32])
              for (const descending of [false, true])
                for (const family of [
                  { name: 'movs', opcode: 0xa4, source: true, destination: true },
                  { name: 'stos', opcode: 0xaa, source: false, destination: true },
                  { name: 'lods', opcode: 0xac, source: true, destination: false },
                  { name: 'cmps', opcode: 0xa6, source: true, destination: true },
                  { name: 'scas', opcode: 0xae, source: false, destination: true },
                ]) {
                  const comparison = family.name === 'cmps' || family.name === 'scas';
                  for (const repeat of comparison ? ['', 'f3', 'f2'] : ['', 'f3']) {
                    const count = repeat === '' ? 1 : 2;
                    const width = row.bits / 8;
                    const direction = descending ? 0x400n : 0n;
                    const defaultWidth = mode.default32 ? 32 : 16;
                    const operand =
                      row.bits === 8 || row.bits === 64 || row.bits === defaultWidth ? '' : '66';
                    const addressOverride =
                      address === (mode.long64 ? 64 : defaultWidth) ? '' : '67';
                    const code =
                      operand +
                      addressOverride +
                      repeat +
                      (row.bits === 64 ? '48' : '') +
                      (family.opcode + Number(row.bits !== 8)).toString(16);
                    let source = 'a5'.repeat(48),
                      destination = 'a5'.repeat(48);
                    let expectedDestination = destination;
                    for (let element = 0; element < count; element++) {
                      const at = 16 + (descending ? -1 : 1) * element * width;
                      source = patch(source, at, row.load);
                      const destinationElement =
                        family.name === 'scas'
                          ? repeat === 'f3'
                            ? row.accumulator
                            : row.scan
                          : family.name === 'cmps'
                            ? repeat === 'f3'
                              ? row.load
                              : row.unequal
                            : 'a5'.repeat(width);
                      destination = patch(destination, at, destinationElement);
                      if (family.name === 'movs' || family.name === 'stos')
                        expectedDestination = patch(
                          expectedDestination,
                          at,
                          family.name === 'movs' ? row.load : row.accumulator,
                        );
                    }
                    if (family.name !== 'movs' && family.name !== 'stos')
                      expectedDestination = destination;
                    await using(
                      compiler,
                      code,
                      mode.execution,
                      async (cpu) => {
                        const rawSource = address === 64 ? 0x4010n : 0x9988776600004010n;
                        const rawDestination = address === 64 ? 0x5010n : 0xaabbccdd00005010n;
                        const rawCount =
                          address === 64
                            ? BigInt(repeat === '' ? 0 : 2)
                            : 0x778899aa00000000n + BigInt(repeat === '' ? 0 : 2);
                        const flags =
                          (comparison ? (repeat === 'f3' ? 2n : 0x42n) : 0x8d7n) | direction;
                        const before = input(
                          0x1000n,
                          { 1: rawCount, 6: rawSource, 7: rawDestination },
                          flags,
                        );
                        cpu.setState(before);
                        const delta = BigInt((descending ? -1 : 1) * count * width);
                        const updates: Record<number, bigint> = {};
                        if (family.source)
                          updates[6] =
                            (address === 32 && mode.long64 ? 0x4010n : rawSource) + delta;
                        if (family.destination)
                          updates[7] =
                            (address === 32 && mode.long64 ? 0x5010n : rawDestination) + delta;
                        if (repeat !== '')
                          updates[1] =
                            address === 64 || (address === 32 && mode.long64)
                              ? 0n
                              : 0x778899aa00000000n;
                        if (family.name === 'lods')
                          updates[0] = row.bits === 32 && mode.long64 ? 0x7bn : row.loaded;
                        const expectedFlags = comparison
                          ? (repeat === 'f3' ? 0x46n : 0x97n) | direction
                          : flags;
                        outcome(
                          await cpu.run({ budget: 1n, repeatBudget: repeat === '' ? 0n : 2n }),
                          'budget',
                          1n,
                          1n,
                          repeat === '' ? 0n : 2n,
                          repeat === '' ? 0n : 2n,
                          changed(
                            before,
                            0x1000n + BigInt(code.length / 2),
                            updates,
                            expectedFlags,
                          ),
                        );
                        memory(cpu, 0x4000n, source);
                        memory(cpu, 0x5000n, expectedDestination);
                        memory(cpu, 0x1000n, code);
                      },
                      {
                        data: [
                          { base: 0x4000n, bytes: source },
                          { base: 0x5000n, bytes: destination },
                        ],
                      },
                    );
                  }
                }
      },
    },
  ];
}
