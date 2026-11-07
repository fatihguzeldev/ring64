import { createCpu } from '../../../host/index.js';
import { LIMITS, equal, fault, hex, memory } from '../../support/fixture.js';
import {
  LONG,
  banks,
  bytes,
  changed,
  input,
  outcome,
  using,
  xmm,
  type Scenario,
} from './fixture.js';

const rx = { read: true, write: false, execute: true };
const rw = { read: true, write: true, execute: false };
export function reuseScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'SIMD selected bank publication preserves skipped writers and incoming banks at every retained entry',
      async run() {
        // MOVDQA15,8; JMP over MOVDQA7,15; MOVDQA8,7.
        const code = '66450f6ff8eb0566410f6fff66440f6fc7';
        await using(compiler, code, LONG, async (cpu) => {
          const raw = banks(),
            warm = input();
          cpu.setState(warm);
          cpu.setXmmState(raw);
          await cpu.run({ budget: 1n, repeatBudget: 0n });
          for (const pc of [0x1005n, 0x1007n, 0x100cn]) {
            cpu.setState(input(pc));
            await cpu.run({ budget: 1n, repeatBudget: 0n });
          }
          for (const [pc, budget, next, updates] of [
            [
              0x1000n,
              3n,
              0x1011n,
              [
                [15, 8],
                [8, 7],
              ],
            ],
            [0x1005n, 2n, 0x1011n, [[8, 7]]],
            [
              0x1007n,
              2n,
              0x1011n,
              [
                [7, 15],
                [8, 15],
              ],
            ],
            [0x100cn, 1n, 0x1011n, [[8, 7]]],
          ] as const) {
            const fresh = banks().map((x) => x ^ 0xffff0000ffffn),
              expected = fresh.slice(),
              before = input(pc, {}, 0xcd7n);
            for (const [dst, src] of updates) expected[dst] = fresh[src]!;
            cpu.setState(before);
            cpu.setXmmState(fresh);
            const result = await cpu.run({ budget, repeatBudget: 0n });
            outcome(result, 'budget', budget, budget, 0n, 0n, changed(before, next));
            xmm(cpu, expected);
            equal(result.resources.compilations, 0, 'middle entries retain owner');
          }
        });
      },
    },
    {
      name: 'SIMD committed predecessors survive a wide fault and scalar FS faults retain their selected segment in mixed units',
      async run() {
        for (const scalar of [false, true])
          await using(
            compiler,
            scalar ? '660fefc164488b03660f6f13' : '660fefc1660f6f13',
            LONG,
            async (cpu) => {
              const before = input(0x1000n, { 3: 0x6000n }, 0xcd7n),
                raw = banks(),
                expected = raw.slice();
              expected[0] = raw[0]! ^ raw[1]!;
              cpu.setState(before);
              cpu.setXmmState(raw);
              const result = await cpu.run({ budget: 3n, repeatBudget: 0n });
              outcome(result, 'data-fault', 3n, 1n, 0n, 0n, changed(before, 0x1004n));
              fault(result, {
                instructionPc: 0x1004n,
                address: 0x6000n,
                width: scalar ? 8 : 16,
                access: 'read',
                cause: 'unmapped',
                failingAddress: 0x6000n,
                segment: scalar ? 'fs' : 'ds',
              });
              xmm(cpu, expected);
            },
          );
      },
    },
    {
      name: 'SIMD wide code aliases commit every byte before invalidation and obey budget and stop at the next boundary',
      async run() {
        for (const identity of [false, true])
          for (const gate of ['budget', 'stop', 'continue'] as const) {
            const original = 'b801000000' + '90'.repeat(11),
              replacement = identity ? original : 'b802000000' + '90'.repeat(11);
            const code = '90f30f7f03' + original + 'f4';
            // First eight bytes alias the active owner; final eight are ordinary data.
            const maps = [
              { base: 0x1000n, backing: 'code', offset: 0, length: 22, permissions: rx },
              { base: 0x6000n, backing: 'code', offset: 5, length: 8, permissions: rw },
              { base: 0x6008n, backing: 'tail', offset: 1, length: 8, permissions: rw },
              { base: 0x7000n, backing: 'tail', offset: 0, length: 10, permissions: rx },
            ];
            const cpu = await createCpu({
              compiler,
              context: LONG,
              entry: 0x1000n,
              memory: {
                backings: [
                  { id: 'code', bytes: hex(code) },
                  { id: 'tail', bytes: hex('a5' + '90'.repeat(8) + '5a') },
                ],
                mappings: maps,
              },
              memoryLimits: { maxBackings: 2, maxMappings: 4, maxBackingBytes: 32 },
              limits: LIMITS,
            });
            try {
              cpu.setState(input(0x1000n));
              await cpu.run({ budget: 1n, repeatBudget: 0n });
              const raw = banks();
              raw[0] = BigInt('0x' + replacement.match(/../g)!.reverse().join(''));
              const before = input(0x1001n, { 3: 0x6000n }, 0xcd7n);
              cpu.setState(before);
              cpu.setXmmState(raw);
              const budget = gate === 'budget' ? 1n : 2n;
              const result = await cpu.run({
                budget,
                repeatBudget: 0n,
                ...(gate === 'stop' ? { stop: 0x1005n } : {}),
              });
              const executesNext = gate === 'continue';
              outcome(
                result,
                gate === 'stop' ? 'stop' : 'budget',
                budget,
                executesNext ? 2n : 1n,
                0n,
                0n,
                changed(
                  before,
                  executesNext ? 0x100an : 0x1005n,
                  executesNext ? { 0: identity ? 1n : 2n } : {},
                ),
              );
              xmm(cpu, raw);
              memory(cpu, 0x6000n, replacement);
              memory(cpu, 0x7000n, 'a5' + replacement.slice(16) + '5a');
              equal(
                result.resources.compilations,
                executesNext ? 1 : 0,
                'no compile before committed gate',
              );
              if (!executesNext) {
                const next = await cpu.run({ budget: 1n, repeatBudget: 0n });
                outcome(
                  next,
                  'budget',
                  1n,
                  1n,
                  0n,
                  0n,
                  changed(before, 0x100an, { 0: identity ? 1n : 2n }),
                );
                equal(
                  next.resources.compilations,
                  1,
                  'identity and changed stores invalidate active code',
                );
                xmm(cpu, raw);
              }
            } finally {
              cpu.dispose();
            }
          }
      },
    },
    {
      name: 'SIMD code and ordinary mappings sharing one backing apply writes in ascending linear order',
      async run() {
        // Each 8-byte linear half aliases the same eight backing bytes: later half wins.
        const code = 'f30f7f03';
        const cpu = await createCpu({
          compiler,
          context: LONG,
          entry: 0x1000n,
          memory: {
            backings: [
              { id: 'code', bytes: hex(code) },
              { id: 'data', bytes: hex('a5' + '00'.repeat(8) + '5a') },
            ],
            mappings: [
              { base: 0x1000n, backing: 'code', offset: 0, length: 4, permissions: rx },
              { base: 0x6000n, backing: 'data', offset: 1, length: 8, permissions: rw },
              { base: 0x6008n, backing: 'data', offset: 1, length: 8, permissions: rw },
              { base: 0x7000n, backing: 'data', offset: 0, length: 10, permissions: rx },
            ],
          },
          memoryLimits: { maxBackings: 2, maxMappings: 4, maxBackingBytes: 14 },
          limits: LIMITS,
        });
        try {
          const raw = banks(),
            before = input(0x1000n, { 3: 0x6000n }, 0xcd7n);
          cpu.setXmmState(raw);
          cpu.setState(before);
          outcome(
            await cpu.run({ budget: 1n, repeatBudget: 0n }),
            'budget',
            1n,
            1n,
            0n,
            0n,
            changed(before, 0x1004n),
          );
          xmm(cpu, raw);
          memory(cpu, 0x7000n, 'a5' + bytes(raw[0]!).slice(16) + '5a');
        } finally {
          cpu.dispose();
        }
      },
    },
    {
      name: 'SIMD mixed regions retain REP accounting without consuming another repetition allowance',
      async run() {
        await using(
          compiler,
          'f3a4660ffcc1',
          LONG,
          async (cpu) => {
            const raw = banks();
            raw[0] = 0x01010101010101010101010101010101n;
            raw[1] = raw[0];
            const expected = raw.slice();
            expected[0] = raw[0] * 2n;
            const before = input(0x1000n, { 1: 1n, 6: 0x6000n, 7: 0x7000n }, 0x8d7n);
            cpu.setState(before);
            cpu.setXmmState(raw);
            outcome(
              await cpu.run({ budget: 2n, repeatBudget: 1n }),
              'budget',
              2n,
              2n,
              1n,
              1n,
              changed(before, 0x1006n, { 1: 0n, 6: 0x6001n, 7: 0x7001n }),
            );
            xmm(cpu, expected);
            memory(cpu, 0x7000n, '7b');
            memory(cpu, 0x6000n, '7b');
          },
          {
            data: [
              { base: 0x6000n, bytes: '7b' },
              { base: 0x7000n, bytes: 'a5' },
            ],
          },
        );
      },
    },
    {
      name: 'SIMD bank values survive translation eviction and resource refusal before entry',
      async run() {
        for (const refused of [false, true])
          await using(
            compiler,
            '660fefc1660fefc2',
            LONG,
            async (cpu) => {
              const raw = banks();
              cpu.setXmmState(raw);
              if (refused) {
                const before = input();
                cpu.setState(before);
                outcome(
                  await cpu.run({ budget: 1n, repeatBudget: 0n }),
                  'resource-limit',
                  1n,
                  0n,
                  0n,
                  0n,
                  before,
                );
                xmm(cpu, raw);
              } else {
                const expected = raw.slice();
                for (const pc of [0x1000n, 0x1004n, 0x1000n, 0x1004n]) {
                  const before = input(pc);
                  cpu.setState(before);
                  expected[0] = expected[0]! ^ expected[pc === 0x1000n ? 1 : 2]!;
                  const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
                  outcome(result, 'budget', 1n, 1n, 0n, 0n, changed(before, pc + 4n));
                  xmm(cpu, expected);
                  equal(
                    result.resources.compilations,
                    1,
                    'one-owner capacity forces fresh translation',
                  );
                }
              }
            },
            {
              limits: refused
                ? { maxArtifactBytes: 1 }
                : { maxInstructions: 1, maxCachedArtifacts: 1 },
            },
          );
      },
    },
  ];
}
