import {
  LONG,
  DATA,
  MASK64,
  R,
  W,
  map,
  mapped,
  transition,
  context,
  profiles,
  using,
  input,
  changed,
  outcome,
  stack,
  seed,
  banks,
  xmm,
  x87,
  other,
  bytes,
  memory,
  equal,
  fault,
  pending,
  noFault,
  hex,
  type Scenario,
} from './fixture.js';

export function storeScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'streaming stores retain exact raw widths across all fourteen imported profiles and address overrides',
      async run() {
        for (const p of profiles)
          for (const override of [false, true])
            for (const [prefix, opcode, width, source] of [
              ['', 'e7', 8, 'mmx'],
              ['66', 'e7', 16, 'xmm'],
              ['', '2b', 16, 'xmm'],
              ['66', '2b', 16, 'xmm'],
              ['', 'c3', 4, 'gp'],
            ] as const) {
              const execution = p.mode === 'long64' ? LONG : context(p.mode, p.code32, p.stack32);
              const address16 = p.mode !== 'long64' && p.code32 === override;
              const address = p.mode === 'long64' && !override ? 0x6000n : 0x123400006000n;
              const code =
                (override ? '67' : '') + prefix + '0f' + opcode + (address16 ? '0f' : '08');
              await using(
                compiler,
                code,
                execution,
                async (cpu) => {
                  const before = input(0x1000n, {
                    [address16 ? 3 : 0]: address,
                    1: 0x8877665544332211n,
                  });
                  const numeric = stack({}, 5, 0x37f, 0x4700),
                    vector = banks();
                  numeric.registers[1] = (0x1234n << 64n) | (DATA & MASK64);
                  vector[1] = DATA;
                  cpu.setState(before);
                  seed(cpu, numeric);
                  cpu.setXmmState(vector);
                  const result = await cpu.run({ budget: 1n, repeatBudget: 7n });
                  outcome(
                    result,
                    'budget',
                    1n,
                    1n,
                    7n,
                    0n,
                    changed(before, 0x1000n + BigInt(code.length / 2)),
                  );
                  noFault(result);
                  x87(cpu, source === 'mmx' ? transition(numeric) : numeric);
                  xmm(cpu, vector);
                  equal(cpu.readMxcsr(), 0xffc5, 'raw streaming payload leaves MXCSR');
                  memory(
                    cpu,
                    0x5fffn,
                    'a5' +
                      (source === 'gp' ? '11223344' : bytes(DATA, width)) +
                      'a5'.repeat(17 - width),
                  );
                },
                { data: [{ base: 0x5fffn, bytes: 'a5'.repeat(18) }] },
              );
            }
      },
    },
    {
      name: 'streaming extended GPR and XMM sources use live generated values and exact REX widths',
      async run() {
        for (const [code, width, value, gp, vectorIndex] of [
          ['49b888776655443322114c0fc303', 8, 0x1122334455667788n, 8, -1],
          ['41b888776655440fc303', 4, 0x55667788n, 8, -1],
          ['66450fefc066440fe703', 16, 0n, -1, 8],
          ['66450fefc0440f2b03', 16, 0n, -1, 8],
          ['66450fefc066440f2b03', 16, 0n, -1, 8],
        ] as const)
          await using(
            compiler,
            code,
            LONG,
            async (cpu) => {
              const before = input(0x1000n, { 3: 0x6000n }),
                numeric = stack({}, 4),
                vector = banks();
              cpu.setState(before);
              seed(cpu, numeric);
              cpu.setXmmState(vector);
              const result = await cpu.run({ budget: 2n });
              const after = changed(before, 0x1000n + BigInt(code.length / 2));
              if (gp >= 0) after.registers[gp] = value;
              if (vectorIndex >= 0) vector[vectorIndex] = 0n;
              outcome(result, 'budget', 2n, 2n, 2n, 0n, after);
              noFault(result);
              x87(cpu, numeric);
              xmm(cpu, vector);
              memory(cpu, 0x6000n, bytes(value, width) + 'a5'.repeat(16 - width));
            },
            { data: [{ base: 0x6000n, bytes: 'a5'.repeat(16) }] },
          );
      },
    },
    {
      name: 'streaming stores admit write-only mappings across every split without reading or widening the operand',
      async run() {
        for (const [code, width] of [
          ['0fe70b', 8],
          ['660fe70b', 16],
          ['0f2b0b', 16],
          ['660f2b0b', 16],
          ['480fc30b', 8],
          ['0fc30b', 4],
        ] as const)
          for (let split = 1; split < width; split++) {
            await mapped(
              compiler,
              code,
              [{ id: 'data', bytes: hex('a5'.repeat(20)) }],
              [
                map(0x6000n, 'data', split, W, 2),
                map(0x6000n + BigInt(split), 'data', width - split, W, 2 + split),
                map(0x8000n, 'data', 20, R),
              ],
              async (cpu) => {
                const before = input(0x1000n, { 3: 0x6000n, 1: DATA & MASK64 }),
                  numeric = stack({}, 5),
                  vector = banks();
                numeric.registers[1] = (0x7654n << 64n) | (DATA & MASK64);
                vector[1] = DATA;
                cpu.setState(before);
                seed(cpu, numeric);
                cpu.setXmmState(vector);
                const result = await cpu.run({ budget: 1n });
                outcome(
                  result,
                  'budget',
                  1n,
                  1n,
                  1n,
                  0n,
                  changed(before, 0x1000n + BigInt(code.length / 2)),
                );
                x87(cpu, code === '0fe70b' ? transition(numeric) : numeric);
                xmm(cpu, vector);
                noFault(result);
                memory(cpu, 0x8000n, 'a5a5' + bytes(DATA, width) + 'a5'.repeat(18 - width));
              },
            );
          }
      },
    },
    {
      name: 'streaming stores preflight late permission and missing bytes before memory MMX and owner publication',
      async run() {
        for (const [code, width, q] of [
          ['0fe703', 8, true],
          ['660fe703', 16, false],
          ['0f2b03', 16, false],
          ['660f2b03', 16, false],
          ['480fc303', 8, false],
          ['0fc303', 4, false],
        ] as const)
          for (const permission of [false, true])
            await mapped(
              compiler,
              code,
              [{ id: 'data', bytes: hex('a5'.repeat(width + 4)) }],
              [
                map(0x6000n, 'data', width - 1, W, 2),
                map(0x8000n, 'data', width + 4, R),
                ...(permission ? [map(0x6000n + BigInt(width - 1), 'data', 1, R, width + 1)] : []),
              ],
              async (cpu) => {
                const before = input(0x1000n, { 3: 0x6000n, 0: DATA & MASK64 }),
                  numeric = stack({}, 5),
                  vector = banks();
                numeric.registers[0] = (0x1234n << 64n) | (DATA & MASK64);
                vector[0] = DATA;
                cpu.setState(before);
                seed(cpu, numeric);
                cpu.setXmmState(vector);
                const result = await cpu.run({ budget: 1n, repeatBudget: 13n });
                outcome(result, 'data-fault', 1n, 0n, 13n, 0n, before);
                fault(result, {
                  instructionPc: 0x1000n,
                  address: 0x6000n,
                  width,
                  access: 'write',
                  cause: permission ? 'permission' : 'unmapped',
                  failingAddress: 0x6000n + BigInt(width - 1),
                  segment: 'ds',
                });
                x87(cpu, numeric);
                xmm(cpu, vector);
                memory(cpu, 0x8000n, 'a5'.repeat(width + 4));
                equal(
                  result.resources.cachedArtifacts,
                  1,
                  q
                    ? 'failed Q store preserves owner and transition'
                    : 'failed NT store preserves owner',
                );
              },
            );
      },
    },
    {
      name: 'streaming MMX pending exceptions precede invalid destinations and repaired retained entries use fresh payloads',
      async run() {
        await using(compiler, '0fe703', LONG, async (cpu) => {
          const before = input(0x1000n, { 3: 0x6000n }),
            numeric = stack({}, 5, 0x37b, 0x8084);
          cpu.setState(before);
          seed(cpu, numeric);
          const failed = await cpu.run({ budget: 1n, repeatBudget: 9n });
          outcome(failed, 'x87-exception', 1n, 0n, 9n, 0n, before);
          pending(failed, numeric, 0x1000n);
          x87(cpu, numeric);
          other(cpu);
          const repaired = stack({}, 6);
          repaired.registers[0] = 0x98748877665544332211n;
          cpu.setX87State(repaired);
          const result = await cpu.run({ budget: 1n });
          outcome(result, 'data-fault', 1n, 0n, 1n, 0n, before);
          x87(cpu, repaired);
          equal(
            result.resources.compilations,
            0,
            'pending state repair retains compiled instruction',
          );
        });
      },
    },
    {
      name: 'streaming 128-bit alignment follows address checks and precedes mapping while Q and I remain unaligned',
      async run() {
        for (const code of ['660fe703', '0f2b03', '660f2b03'])
          for (const at of [0x6001n, 0x800000000001n])
            await using(compiler, code, LONG, async (cpu) => {
              const before = input(0x1000n, { 3: at }),
                numeric = stack({}, 5);
              cpu.setState(before);
              seed(cpu, numeric);
              const result = await cpu.run({ budget: 1n });
              outcome(
                result,
                at === 0x6001n ? 'alignment-fault' : 'data-fault',
                1n,
                0n,
                1n,
                0n,
                before,
              );
              if (at === 0x6001n) {
                equal(result.alignmentFault?.address, at, 'translated unaligned start');
                equal(result.alignmentFault?.alignment, 16, 'selected alignment');
                equal(result.alignmentFault?.width, 16, 'complete aligned-store width');
                equal(result.fault, undefined, 'alignment precedes absent mapping');
              } else
                equal(result.fault?.cause, 'noncanonical', 'address domain precedes alignment');
              x87(cpu, numeric);
              other(cpu);
            });
        for (const [code, width] of [
          ['0fe703', 8],
          ['480fc303', 8],
          ['0fc303', 4],
        ] as const)
          await using(
            compiler,
            code,
            LONG,
            async (cpu) => {
              const before = input(0x1000n, { 3: 0x6001n, 0: DATA & MASK64 }),
                numeric = stack({}, 5);
              numeric.registers[0] = DATA & MASK64;
              cpu.setState(before);
              seed(cpu, numeric);
              const result = await cpu.run({ budget: 1n });
              outcome(
                result,
                'budget',
                1n,
                1n,
                1n,
                0n,
                changed(before, 0x1000n + BigInt(code.length / 2)),
              );
              noFault(result);
              memory(cpu, 0x6000n, 'a5' + bytes(DATA, width) + 'a5');
            },
            { data: [{ base: 0x6000n, bytes: 'a5'.repeat(width + 2) }] },
          );
      },
    },
  ];
}
