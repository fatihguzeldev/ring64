import { createCpu } from '../../../host/index.js';
import { LIMITS, equal, fault, hex, memory } from '../../support/fixture.js';
import {
  LONG,
  banks,
  changed,
  input,
  mxcsr,
  noFault,
  outcome,
  simdFault,
  using,
  xmm,
  type Scenario,
} from './fixture.js';
const rx = { read: true, write: false, execute: true },
  rw = { read: true, write: true, execute: false };
export function reuseScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'MXCSR identity code stores invalidate retained executable owners and preserve old unmasked status',
      async run() {
        const code = '0fae1b9090000082';
        const cpu = await createCpu({
          compiler,
          context: LONG,
          entry: 0x1000n,
          memory: {
            backings: [{ id: 'code', bytes: hex(code) }],
            mappings: [
              { base: 0x1000n, backing: 'code', offset: 0, length: 8, permissions: rx },
              {
                base: 0x6000n,
                backing: 'code',
                offset: 3,
                length: 4,
                permissions: { read: false, write: true, execute: false },
              },
            ],
          },
          memoryLimits: { maxBackings: 1, maxMappings: 2, maxBackingBytes: 8 },
          limits: LIMITS,
        });
        try {
          const raw = banks(),
            before = input(0x1000n, { 3: 0x6000n }, 0xcd7n);
          cpu.setState(before);
          cpu.setXmmState(raw);
          cpu.setMxcsr(0x9090);
          const first = await cpu.run({ budget: 1n, repeatBudget: 0n });
          outcome(first, 'budget', 1n, 1n, 0n, 0n, changed(before, 0x1003n));
          memory(cpu, 0x1000n, code);
          xmm(cpu, raw);
          mxcsr(cpu, 0x9090);
          noFault(first);
          equal(cpu.inspectTranslations().length, 0, 'identity write prunes active owner');
          const next = await cpu.run({ budget: 1n, repeatBudget: 0n });
          outcome(next, 'budget', 1n, 1n, 0n, 0n, changed(before, 0x1004n));
          equal(next.resources.compilations, 1, 'identity store forces a fresh successor owner');
          xmm(cpu, raw);
          mxcsr(cpu, 0x9090);
          noFault(next);
        } finally {
          cpu.dispose();
        }
      },
    },
    {
      name: 'floating live predecessors publish changed banks GPR conversions and sticky status before a later numeric fault',
      async run() {
        await using(compiler, 'f30f58c1f30f2cc0f30f5ec2', LONG, async (cpu) => {
          const before = input(0x1000n, {}, 0xcd7n),
            raw = banks();
          raw[0] = (raw[0]! & ~0xffffffffn) | 0x3f800001n;
          raw[1] = (raw[1]! & ~0xffffffffn) | 0x33800000n;
          raw[2] = raw[2]! & ~0xffffffffn;
          cpu.setState(before);
          cpu.setXmmState(raw);
          cpu.setMxcsr(0x1d80);
          const failed = await cpu.run({ budget: 5n, repeatBudget: 7n });
          outcome(failed, 'simd-exception', 5n, 2n, 7n, 0n, changed(before, 0x1008n, { 0: 1n }));
          simdFault(failed, 0x1da0, 0x1da4, 4, 4, 'pre-computation', 0x1008n);
          mxcsr(cpu, 0x1da4);
          const expected = raw.slice();
          expected[0] = (raw[0]! & ~0xffffffffn) | 0x3f800002n;
          xmm(cpu, expected);
          expected[0] = (expected[0]! & ~0xffffffffn) | 0x40800000n;
          expected[2] = (expected[2]! & ~0xffffffffn) | 0x40000000n;
          cpu.setXmmState(expected);
          const resumed = cpu.readState();
          const repaired = await cpu.run({ budget: 1n, repeatBudget: 0n });
          expected[0] = (expected[0]! & ~0xffffffffn) | 0x40000000n;
          outcome(repaired, 'budget', 1n, 1n, 0n, 0n, changed(resumed, 0x100cn));
          noFault(repaired);
          xmm(cpu, expected);
          mxcsr(cpu, 0x1da4);
          equal(
            repaired.resources.compilations,
            0,
            'old sticky unmasked condition does not fault or recompile',
          );
        });
      },
    },
    {
      name: 'floating predecessor status survives a scalar FS fault in an artifact importing numeric and wide helpers',
      async run() {
        await using(compiler, 'f30f58c164488b03f30f1013', LONG, async (cpu) => {
          const raw = banks(),
            before = input(0x1000n, { 3: 0x6000n }, 0xcd7n);
          raw[0] = (raw[0]! & ~0xffffffffn) | 0x3f800001n;
          raw[1] = (raw[1]! & ~0xffffffffn) | 0x33800000n;
          const expected = raw.slice();
          expected[0] = (raw[0]! & ~0xffffffffn) | 0x3f800002n;
          cpu.setState(before);
          cpu.setXmmState(raw);
          cpu.setMxcsr(0x1f80);
          const result = await cpu.run({ budget: 3n, repeatBudget: 0n });
          outcome(result, 'data-fault', 3n, 1n, 0n, 0n, changed(before, 0x1004n));
          fault(result, {
            instructionPc: 0x1004n,
            address: 0x6000n,
            width: 8,
            access: 'read',
            cause: 'unmapped',
            failingAddress: 0x6000n,
            segment: 'fs',
          });
          xmm(cpu, expected);
          mxcsr(cpu, 0x1fa0);
          cpu.setState(cpu.readState());
          mxcsr(cpu, 0x1fa0);
          cpu.setXmmState(expected);
          mxcsr(cpu, 0x1fa0);
        });
      },
    },
    {
      name: 'floating fault after a retired REP preserves completed memory work and both independent budget accounts',
      async run() {
        await using(
          compiler,
          'f3a4f30f58c1',
          LONG,
          async (cpu) => {
            const raw = banks(),
              before = input(0x1000n, { 1: 1n, 6: 0x6000n, 7: 0x7000n }, 0x8d7n);
            raw[0] = (raw[0]! & ~0xffffffffn) | 0x3f800000n;
            raw[1] = (raw[1]! & ~0xffffffffn) | 0x33800000n;
            cpu.setState(before);
            cpu.setXmmState(raw);
            cpu.setMxcsr(0x0f80);
            const result = await cpu.run({ budget: 2n, repeatBudget: 1n });
            const atFault = changed(before, 0x1002n, { 1: 0n, 6: 0x6001n, 7: 0x7001n });
            outcome(result, 'simd-exception', 2n, 1n, 1n, 1n, atFault);
            simdFault(result, 0x0f80, 0x0fa0, 32, 32, 'post-computation', 0x1002n);
            xmm(cpu, raw);
            mxcsr(cpu, 0x0fa0);
            memory(cpu, 0x6000n, '7b');
            memory(cpu, 0x7000n, '7b');
            cpu.setMxcsr(0x1fa0);
            const retry = await cpu.run({ budget: 1n, repeatBudget: 0n });
            outcome(retry, 'budget', 1n, 1n, 0n, 0n, changed(atFault, 0x1006n));
            xmm(cpu, raw);
            mxcsr(cpu, 0x1fa0);
            noFault(retry);
            equal(retry.resources.compilations, 0, 'REP predecessor not replayed on numeric retry');
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
      name: 'floating retained entries load skipped written banks and never evaluate skipped exceptional operations',
      async run() {
        const code = 'f30f58c1eb04f30f58d3f30f58e5';
        await using(compiler, code, LONG, async (cpu) => {
          for (const pc of [0x1000n, 0x1004n, 0x1006n, 0x100an]) {
            cpu.setState(input(pc));
            cpu.setMxcsr(0x1f80);
            await cpu.run({ budget: 1n, repeatBudget: 0n });
          }
          const raw = banks();
          for (const i of [0, 1, 3, 4, 5]) raw[i] = (raw[i]! & ~0xffffffffn) | 0x3f800000n;
          raw[2] = (raw[2]! & ~0xffffffffn) | 0x7f800001n;
          for (const [pc, budget, changes] of [
            [0x1000n, 3n, [0, 4]],
            [0x1004n, 2n, [4]],
            [0x100an, 1n, [4]],
          ] as const) {
            const before = input(pc),
              expected = raw.slice();
            for (const dst of changes) expected[dst] = (raw[dst]! & ~0xffffffffn) | 0x40000000n;
            cpu.setState(before);
            cpu.setXmmState(raw);
            cpu.setMxcsr(0x1f00);
            const result = await cpu.run({ budget, repeatBudget: 0n });
            outcome(result, 'budget', budget, budget, 0n, 0n, changed(before, 0x100en));
            xmm(cpu, expected);
            mxcsr(cpu, 0x1f00);
            noFault(result);
            equal(
              result.resources.compilations,
              0,
              'retained entries use runtime banks and controls',
            );
          }
          const before = input(0x1006n);
          cpu.setState(before);
          cpu.setXmmState(raw);
          cpu.setMxcsr(0x1f00);
          const result = await cpu.run({ budget: 2n, repeatBudget: 0n });
          outcome(result, 'simd-exception', 2n, 0n, 0n, 0n, before);
          simdFault(result, 0x1f00, 0x1f01, 1, 1, 'pre-computation', 0x1006n);
          xmm(cpu, raw);
          mxcsr(cpu, 0x1f01);
        });
      },
    },
    {
      name: 'MXCSR and half stores invalidate every code alias after bytes retire and before stale successors or middle entries',
      async run() {
        for (const half of [false, true])
          for (const gate of ['budget', 'stop', 'continue'] as const) {
            const prefix = half ? '0f1303' : '0fae1b',
              next = 0x1000n + BigInt(prefix.length / 2),
              original = half ? 'b801000000909090' : 'fc909090',
              stored = half ? 'b802000000909090' : '82909090',
              code = prefix + original + '82';
            const cpu = await createCpu({
              compiler,
              context: LONG,
              entry: 0x1000n,
              memory: {
                backings: [{ id: 'code', bytes: hex(code) }],
                mappings: [
                  {
                    base: 0x1000n,
                    backing: 'code',
                    offset: 0,
                    length: code.length / 2,
                    permissions: rx,
                  },
                  {
                    base: 0x6000n,
                    backing: 'code',
                    offset: prefix.length / 2,
                    length: half ? 8 : 4,
                    permissions: { ...rw, read: false },
                  },
                ],
              },
              memoryLimits: { maxBackings: 1, maxMappings: 2, maxBackingBytes: code.length / 2 },
              limits: LIMITS,
            });
            try {
              const raw = banks(),
                before = input(0x1000n, { 3: 0x6000n }, 0xcd7n);
              if (half) raw[0] = (raw[0]! & ~0xffffffffffffffffn) | 0x90909000000002b8n;
              // STMXCSR replaces decoded CLD with an unsupported opcode, preserving the source frontier.
              const csr = half ? 0x1f80 : 0x9082;
              cpu.setState(before);
              cpu.setXmmState(raw);
              cpu.setMxcsr(csr);
              const budget = gate === 'budget' ? 1n : 2n;
              const result = await cpu.run({
                budget,
                repeatBudget: 0n,
                ...(gate === 'stop' ? { stop: next } : {}),
              });
              if (!half && gate === 'continue')
                outcome(result, 'unsupported', budget, 1n, 0n, 0n, changed(before, next));
              else
                outcome(
                  result,
                  gate === 'stop' ? 'stop' : 'budget',
                  budget,
                  gate === 'continue' ? 2n : 1n,
                  0n,
                  0n,
                  changed(
                    before,
                    gate === 'continue' ? next + 5n : next,
                    gate === 'continue' ? { 0: 2n } : {},
                  ),
                );
              const actualStored = half ? stored : '82900000';
              memory(cpu, 0x1000n, prefix + actualStored + '82');
              xmm(cpu, raw);
              mxcsr(cpu, csr);
              if (gate !== 'continue')
                equal(
                  result.resources.nativeEntries,
                  1,
                  'committed gate does not execute stale continuation',
                );
            } finally {
              cpu.dispose();
            }
          }
      },
    },
    {
      name: 'floating status survives bounded translation eviction and resource refusal before entry',
      async run() {
        for (const refused of [false, true])
          await using(
            compiler,
            'f30f58c1f30f58c2',
            LONG,
            async (cpu) => {
              const raw = banks();
              raw[0] = (raw[0]! & ~0xffffffffn) | 0x3f800000n;
              raw[1] = raw[1]! & ~0xffffffffn;
              raw[2] = raw[2]! & ~0xffffffffn;
              cpu.setXmmState(raw);
              cpu.setMxcsr(0xffff);
              for (const pc of refused ? [0x1000n] : [0x1000n, 0x1004n, 0x1000n, 0x1004n]) {
                const before = input(pc);
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
                outcome(
                  result,
                  refused ? 'resource-limit' : 'budget',
                  1n,
                  refused ? 0n : 1n,
                  0n,
                  0n,
                  refused ? before : changed(before, pc + 4n),
                );
                xmm(cpu, raw);
                mxcsr(cpu, 0xffff);
                if (!refused)
                  equal(result.resources.compilations, 1, 'one-owner cache evicts old entry');
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
