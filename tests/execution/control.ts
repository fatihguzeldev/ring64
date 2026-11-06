import {
  createFixture,
  type Scenario,
  CODE,
  DATA,
  FRAME,
  check,
  equal,
  memory,
  initial,
  changed,
  exit,
  fault,
} from './fixture.js';

export function controlScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createFixture(core);
  return [
    {
      name: 'literal loop retains state across internal edges and resume',
      run: async () => {
        const ram = '1011121314151617a0a1a2a3a4a5a6a7f0f1f2f3f4f5f6f7';
        await using(
          'b800000000b9030000004801c84883e90175f7488903',
          async (cpu) => {
            const input = initial();
            cpu.setState(input);
            exit(
              await cpu.run({ budget: 5n }),
              'budget',
              5n,
              5n,
              changed(input, 0x100an, { 0: 3n, 1: 2n }),
            );
            memory(cpu, DATA - 8n, ram);
            const result = await cpu.run({ budget: 8n, stop: 0x1016n });
            exit(result, 'stop', 8n, 7n, changed(input, 0x1016n, { 0: 6n, 1: 0n }, 0x46n));
            memory(cpu, DATA - 8n, '10111213141516170600000000000000f0f1f2f3f4f5f6f7');
            equal(result.resources.compilations, 0, 'resumed artifact reuse');
            equal(result.resources.nativeEntries, 1, 'one native invocation for the resumed loop');
            check(
              cpu
                .inspectTranslations()
                .some(
                  (unit) =>
                    unit.instructionCount === 6 &&
                    unit.blockCount >= 2 &&
                    unit.entries.includes(CODE) &&
                    unit.entries.includes(0x100an),
                ),
              'missing multi-block loop artifact',
            );
          },
          { ram },
        );
      },
    },
    {
      name: 'all direct branch forms use signed displacements and preserve flags',
      run: async () => {
        for (const item of [
          { code: 'ebfe', target: CODE, flags: 0x8d7n },
          { code: 'e9fbefffff', target: 0n, flags: 0x8d7n },
          { code: '75f7', target: 0xff9n, flags: 2n },
          { code: '75f7', target: 0xff9n, flags: 0x897n },
          { code: '0f85faefffff', target: 0n, flags: 2n },
          { code: '750e', target: CODE + 2n, flags: 0x42n },
          { code: '750e', target: CODE + 2n, flags: 0x8d7n },
          { code: '0f85ffffff7f', target: CODE + 6n, flags: 0x42n },
        ])
          await using(item.code, async (cpu) => {
            const input = initial(CODE, {}, item.flags);
            cpu.setState(input);
            exit(await cpu.run({ budget: 1n }), 'budget', 1n, 1n, changed(input, item.target));
            memory(cpu, DATA - 8n, FRAME);
          });
        await using(
          'eb06',
          async (cpu) => {
            const pc = 0xfffffffffffffff8n;
            const input = initial(pc, {}, 0x8d7n);
            cpu.setState(input);
            exit(await cpu.run({ budget: 1n }), 'budget', 1n, 1n, changed(input, 0n));
          },
          { codeBase: 0xfffffffffffffff8n },
        );
      },
    },
    {
      name: 'conditional targets are checked only when taken',
      run: async () => {
        const pc = 0x7ffffffffff0n;
        await using(
          '750e',
          async (cpu) => {
            const untaken = initial(pc, {}, 0x42n);
            cpu.setState(untaken);
            exit(await cpu.run({ budget: 1n }), 'budget', 1n, 1n, changed(untaken, pc + 2n));
            const taken = initial(pc);
            cpu.setState(taken);
            exit(await cpu.run({ budget: 1n }), 'target-fault', 1n, 0n, taken);
          },
          { codeBase: pc },
        );
      },
    },
    {
      name: 'completed transfers precede next-boundary stop and fetch failure',
      run: async () => {
        await using('e9fbefffff', async (cpu) => {
          const input = initial(CODE, {}, 0x8d7n);
          cpu.setState(input);
          exit(await cpu.run({ budget: 1n }), 'budget', 1n, 1n, changed(input, 0n));
          cpu.setState(input);
          exit(await cpu.run({ budget: 2n, stop: 0n }), 'stop', 2n, 1n, changed(input, 0n));
          cpu.setState(input);
          const result = await cpu.run({ budget: 2n });
          exit(result, 'fetch-fault', 2n, 1n, changed(input, 0n));
          fault(result, {
            instructionPc: 0n,
            address: 0n,
            width: 1,
            access: 'execute',
            cause: 'unmapped',
            failingAddress: 0n,
          });
        });
      },
    },
    {
      name: 'forward branches retain exact boundaries and independent middle entries',
      run: async () => {
        for (const codeBase of [CODE, 0xffff800000001000n]) {
          await using(
            '750ab811000000ba22000000b93300000090',
            async (cpu) => {
              const taken = initial(codeBase);
              cpu.setState(taken);
              exit(
                await cpu.run({ budget: 2n }),
                'budget',
                2n,
                2n,
                changed(taken, codeBase + 17n, { 1: 51n }),
              );

              cpu.setState(taken);
              exit(
                await cpu.run({ budget: 1n, stop: codeBase + 12n }),
                'budget',
                1n,
                1n,
                changed(taken, codeBase + 12n),
              );
              cpu.setState(taken);
              exit(
                await cpu.run({ budget: 2n, stop: codeBase + 12n }),
                'stop',
                2n,
                1n,
                changed(taken, codeBase + 12n),
              );

              const untaken = initial(codeBase, {}, 0x42n);
              cpu.setState(untaken);
              exit(
                await cpu.run({ budget: 4n }),
                'budget',
                4n,
                4n,
                changed(untaken, codeBase + 17n, { 0: 17n, 1: 51n, 2: 34n }),
              );

              const middle = initial(codeBase + 7n, {}, 0x8d7n);
              cpu.setState(middle);
              const resumed = await cpu.run({ budget: 1n });
              exit(resumed, 'budget', 1n, 1n, changed(middle, codeBase + 12n, { 2: 34n }));
              equal(resumed.resources.compilations, 0, 'skipped entry reuses its admitted index');
              equal(resumed.resources.nativeEntries, 1, 'middle entry executes directly');
              memory(cpu, DATA - 8n, FRAME);
            },
            { codeBase },
          );
        }
      },
    },
    {
      name: 'unsupported encodings and reached truncation remain controlled outcomes',
      run: async () => {
        for (const code of [
          'f4',
          '8f',
          '67498b0500000000',
          '67498b0424',
          '1103',
          '6689c0',
          '4889',
          '4883c0',
        ]) {
          await using(code, async (cpu) => {
            const input = initial();
            cpu.setState(input);
            const result = await cpu.run({ budget: 3n });
            const truncated = code === '4889' || code === '4883c0';
            exit(result, truncated ? 'fetch-fault' : 'unsupported', 3n, 0n, input);
            equal(result.resources.compilations, 0, 'diagnostic before compilation');
            if (truncated)
              fault(result, {
                instructionPc: CODE,
                address: CODE + BigInt(code.length / 2),
                width: 1,
                access: 'execute',
                cause: 'unmapped',
                failingAddress: CODE + BigInt(code.length / 2),
              });
          });
        }
      },
    },
    {
      name: 'stop can precede unsupported or truncated code before resuming into failure',
      run: async () => {
        for (const suffix of ['f4', '48b8'])
          await using(`b801000000${suffix}`, async (cpu) => {
            const input = initial();
            cpu.setState(input);
            const after = changed(input, CODE + 5n, { 0: 1n });
            exit(await cpu.run({ budget: 2n, stop: CODE + 5n }), 'stop', 2n, 1n, after);
            exit(
              await cpu.run({ budget: 1n }),
              suffix === 'f4' ? 'unsupported' : 'fetch-fault',
              1n,
              0n,
              after,
            );
            memory(cpu, DATA - 8n, FRAME);
          });
      },
    },
    {
      name: 'discovery does not execute unreachable unsupported or truncated bytes',
      run: async () => {
        await using('eb01f4b801000000', async (cpu) => {
          const input = initial();
          cpu.setState(input);
          exit(
            await cpu.run({ budget: 3n, stop: CODE + 8n }),
            'stop',
            3n,
            2n,
            changed(input, CODE + 8n, { 0: 1n }),
          );
        });
        await using('ebfe48b8', async (cpu) => {
          const input = initial();
          cpu.setState(input);
          exit(await cpu.run({ budget: 3n }), 'budget', 3n, 3n, input);
        });
      },
    },
    {
      name: 'last-u64 byte and canonical-end fallthrough publish reimportable state',
      run: async () => {
        for (const pc of [0xfffffffffffffffbn, 0x7ffffffffffbn])
          await using(
            'b800000000',
            async (cpu) => {
              const input = initial(pc);
              const next = pc === 0xfffffffffffffffbn ? 0n : 0x800000000000n;
              cpu.setState(input);
              const after = changed(input, next, { 0: 0n });
              exit(await cpu.run({ budget: 1n }), 'budget', 1n, 1n, after);
              cpu.setState(after);
              const result = await cpu.run({ budget: 1n });
              exit(result, 'fetch-fault', 1n, 0n, after);
              fault(result, {
                instructionPc: next,
                address: next,
                width: 1,
                access: 'execute',
                cause: next === 0n ? 'unmapped' : 'noncanonical',
                failingAddress: next,
              });
            },
            { codeBase: pc },
          );
        await using(
          'b8',
          async (cpu) => {
            const input = initial(0xffffffffffffffffn);
            cpu.setState(input);
            const result = await cpu.run({ budget: 1n });
            exit(result, 'fetch-fault', 1n, 0n, input);
            fault(result, {
              instructionPc: input.rip,
              address: input.rip,
              width: 2,
              access: 'execute',
              cause: 'address-range',
              failingAddress: 1n << 64n,
            });
          },
          { codeBase: 0xffffffffffffffffn },
        );
      },
    },
    {
      name: 'budget and stop gate execution without becoming discovery constants',
      run: async () => {
        await using('b8010000004801d0488903', async (cpu) => {
          const input = initial(CODE, { 2: 1n });
          cpu.setState(input);
          const zero = await cpu.run({ budget: 0n, stop: CODE });
          exit(zero, 'budget', 0n, 0n, input);
          equal(zero.resources.compilations, 0, 'zero budget admission');
          exit(await cpu.run({ budget: 1n, stop: CODE }), 'stop', 1n, 0n, input);
          exit(
            await cpu.run({ budget: 1n }),
            'budget',
            1n,
            1n,
            changed(input, CODE + 5n, { 0: 1n }),
          );
          exit(
            await cpu.run({ budget: 1n }),
            'budget',
            1n,
            1n,
            changed(input, CODE + 8n, { 0: 2n }),
          );
          exit(
            await cpu.run({ budget: 1n }),
            'budget',
            1n,
            1n,
            changed(input, CODE + 11n, { 0: 2n }),
          );
          memory(cpu, DATA - 8n, '10111213141516170200000000000000f0f1f2f3f4f5f6f7');
          cpu.setState(input);
          const result = await cpu.run({ budget: 4n, stop: CODE + 1n });
          exit(result, 'fetch-fault', 4n, 3n, changed(input, CODE + 11n, { 0: 2n }));
        });
      },
    },
  ];
}
