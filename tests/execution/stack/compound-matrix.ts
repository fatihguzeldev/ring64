import {
  PC,
  RAM_BASE,
  RAM_SIZE,
  compoundProfiles,
  enterBytes,
  operandPrefix,
  input,
  merge,
  wrap,
  mask,
  linear,
  memory,
  completed,
  put,
  preserved,
  hex,
  type CompoundProfile,
  type Scenario,
} from './compound-fixture.js';

// Expected values use slot ordinals and raw register masks, never a decoder or
// the portable compound-stack implementation.
function frame(profile: CompoundProfile, width: number, nesting: number) {
  const ram = new Uint8Array(RAM_SIZE).fill(0xa5);
  for (let index = 1; index < 32; index++)
    put(ram, 0x2000 - index * width, 0x1020304050607000n + BigInt(index), width);
  const before = input(profile);
  const wanted = ram.slice();
  const count = (nesting & 31) === 0 ? 1 : (nesting & 31) + 1;
  const firstSp = merge(before.registers[4]!, 0x5000n - BigInt(width), profile.stackBits);
  const temporary = firstSp & mask(width * 8);
  put(wanted, 0x1000 - width, before.registers[5]!, width);
  for (let ordinal = 1; ordinal < (nesting & 31); ordinal++)
    put(wanted, 0x1000 - (ordinal + 1) * width, 0x1020304050607000n + BigInt(ordinal), width);
  if ((nesting & 31) > 0) put(wanted, 0x1000 - count * width, temporary, width);
  return { ram, before, wanted, count, temporary };
}

export function compoundMatrixScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'compound stack all fourteen imported profiles keep operand stack widths and raw banks independent',
      async run() {
        for (const profile of compoundProfiles)
          for (const width of profile.codeBits === 64 ? [2, 8] : [2, 4]) {
            const f = frame(profile, width, 2),
              code = enterBytes(profile, width, 0x20, 2);
            await linear(
              compiler,
              code,
              profile,
              async (cpu) => {
                cpu.setState(f.before);
                cpu.setTimeState({ tsc: 100n, tscAux: 0x89abcdef });
                const numeric = preserved(cpu),
                  result = await cpu.run({ budget: 1n, repeatBudget: 0n });
                completed(cpu, result, f.before, PC + BigInt(code.length / 2), {
                  4: merge(
                    f.before.registers[4]!,
                    0x5000n - BigInt(f.count * width) - 0x20n,
                    profile.stackBits,
                  ),
                  5: merge(f.before.registers[5]!, f.temporary, width * 8),
                });
                memory(cpu, RAM_BASE, f.wanted, profile.name + ' ENTER image');
                numeric();
              },
              { ram: f.ram },
            );
            if (profile.codeBits === 64) continue;
            for (const pop of [false, true]) {
              const code = operandPrefix(profile, width) + (pop ? '61' : '60');
              const ram = new Uint8Array(RAM_SIZE).fill(0xa5),
                before = input(profile);
              if (pop)
                for (let ordinal = 0; ordinal < 8; ordinal++)
                  put(ram, 0x1000 + ordinal * width, 0xfedcba9876543200n + BigInt(ordinal), width);
              const wanted = ram.slice(),
                registers: Record<number, bigint> = {};
              if (pop) {
                const banks = [7, 6, 5, 3, 2, 1, 0],
                  ordinals = [0, 1, 2, 4, 5, 6, 7];
                for (let index = 0; index < banks.length; index++) {
                  const bank = banks[index]!;
                  registers[bank] = merge(
                    before.registers[bank]!,
                    0xfedcba9876543200n + BigInt(ordinals[index]!),
                    width * 8,
                  );
                }
              } else
                for (let ordinal = 0; ordinal < 8; ordinal++)
                  put(wanted, 0x1000 - (ordinal + 1) * width, before.registers[ordinal]!, width);
              registers[4] = merge(
                before.registers[4]!,
                0x5000n + BigInt((pop ? 8 : -8) * width),
                profile.stackBits,
              );
              await linear(
                compiler,
                code,
                profile,
                async (cpu) => {
                  cpu.setState(before);
                  cpu.setTimeState({ tsc: 100n, tscAux: 0x89abcdef });
                  const numeric = preserved(cpu),
                    result = await cpu.run({ budget: 1n, repeatBudget: 0n });
                  completed(cpu, result, before, PC + BigInt(code.length / 2), registers);
                  memory(cpu, RAM_BASE, wanted, profile.name + (pop ? ' POPA' : ' PUSHA'));
                  numeric();
                },
                { ram },
              );
            }
          }
      },
    },
    {
      name: 'compound ENTER every immediate selects nesting modulo32 at all six operand stack size pairs',
      async run() {
        const profiles = [
          compoundProfiles.find((p) => p.name === 'protected/16/16')!,
          compoundProfiles.find((p) => p.name === 'protected/32/32')!,
          compoundProfiles.find((p) => p.name === 'protected/32/16')!,
          compoundProfiles.at(-1)!,
        ];
        const pairs = profiles.flatMap((profile) =>
          profile.stackBits === 64
            ? [2, 8].map((width) => ({ profile, width }))
            : profile.stackBits === 16 && profile.codeBits === 32
              ? [{ profile, width: 4 }]
              : profile.stackBits === 16
                ? [{ profile, width: 2 }]
                : [2, 4].map((width) => ({ profile, width })),
        );
        for (const { profile, width } of pairs) {
          const first = frame(profile, width, 0);
          await linear(
            compiler,
            enterBytes(profile, width, 0, 0),
            profile,
            async (cpu) => {
              const numeric = preserved(cpu);
              for (let immediate = 0; immediate < 256; immediate++) {
                const f = frame(profile, width, immediate),
                  code = enterBytes(profile, width, 0, immediate);
                cpu.writeMemory(PC, hex(code));
                cpu.writeMemory(RAM_BASE, f.ram);
                cpu.setState(f.before);
                cpu.setTimeState({ tsc: 100n, tscAux: 0x89abcdef });
                const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
                completed(cpu, result, f.before, PC + BigInt(code.length / 2), {
                  4: merge(
                    f.before.registers[4]!,
                    wrap(0x5000n - BigInt(f.count * width), profile.stackBits),
                    profile.stackBits,
                  ),
                  5: merge(f.before.registers[5]!, f.temporary, width * 8),
                });
                memory(cpu, RAM_BASE, f.wanted, `${profile.name}/${width}/imm${immediate}`);
              }
              numeric();
            },
            { ram: first.ram, codeWrite: true },
          );
        }
      },
    },
  ];
}
