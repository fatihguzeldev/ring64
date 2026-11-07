import { equal } from '../../support/fixture.js';
import {
  LONG,
  MASK128,
  banks,
  changed,
  input,
  mxcsr,
  noFault,
  outcome,
  simdFault,
  using,
  vector,
  xmm,
  type Scenario,
} from './fixture.js';

type Packet = {
  code: string;
  a?: bigint;
  b: bigint;
  csr: number;
  after: number;
  value?: bigint;
  width?: 32 | 64;
  raised?: number;
  stage?: 'pre-computation' | 'post-computation';
  gpr?: bigint;
  flags?: bigint;
};
export function literalScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'floating literal packets fix exact tiny overflow NaN payload and rounded integer boundary responses',
      async run() {
        const packets: Packet[] = [
          ...[0, 1, 2, 3].map((rc) => ({
            code: 'f30f58c1',
            a: 0x3f800000n,
            b: 0x33800000n,
            csr: 0x1f80 | (rc << 13),
            after: 0x1fa0 | (rc << 13),
            value: rc === 2 ? 0x3f800001n : 0x3f800000n,
          })),
          ...[0x0f80, 0x0fa0].map((csr) => ({
            code: 'f30f58c1',
            a: 0x3f800000n,
            b: 0x33800000n,
            csr,
            after: 0x0fa0,
            raised: 32,
            stage: 'post-computation' as const,
          })),
          {
            code: 'f30f59c1',
            a: 0x00800000n,
            b: 0x3f000000n,
            csr: 0x1f80,
            after: 0x1f80,
            value: 0x00400000n,
          },
          {
            code: 'f30f59c1',
            a: 0x00800000n,
            b: 0x3f000000n,
            csr: 0x9f80,
            after: 0x9fb0,
            value: 0n,
          },
          {
            code: 'f30f59c1',
            a: 0x00800000n,
            b: 0x3f000000n,
            csr: 0x1780,
            after: 0x1790,
            raised: 16,
            stage: 'post-computation',
          },
          {
            code: 'f30f59c1',
            a: 0x00800000n,
            b: 0x3f000000n,
            csr: 0x9780,
            after: 0x9790,
            raised: 16,
            stage: 'post-computation',
          },
          {
            code: 'f30f59c1',
            a: 0x00800000n,
            b: 0x3f000000n,
            csr: 0x8f80,
            after: 0x8fb0,
            raised: 48,
            stage: 'post-computation',
          },
          {
            code: 'f30f59c1',
            a: 0x7f7fffffn,
            b: 0x40000000n,
            csr: 0x1f80,
            after: 0x1fa8,
            value: 0x7f800000n,
          },
          {
            code: 'f30f59c1',
            a: 0x7f7fffffn,
            b: 0x40000000n,
            csr: 0x1b80,
            after: 0x1b88,
            raised: 8,
            stage: 'post-computation',
          },
          {
            code: 'f30f5dc1',
            a: 0x7fc00011n,
            b: 0x3f800000n,
            csr: 0x1f80,
            after: 0x1f81,
            value: 0x3f800000n,
          },
          {
            code: 'f30f5dc1',
            a: 0x3f800000n,
            b: 0x7f800022n,
            csr: 0x1f80,
            after: 0x1f81,
            value: 0x7f800022n,
          },
          {
            code: 'f30f5dc1',
            a: 0n,
            b: 0x80000000n,
            csr: 0x1f80,
            after: 0x1f80,
            value: 0x80000000n,
          },
          {
            code: 'f30f5dc1',
            a: 0x7fc00011n,
            b: 0x3f800000n,
            csr: 0x1f00,
            after: 0x1f01,
            raised: 1,
            stage: 'pre-computation',
          },
          { code: 'f30f5dc1', a: 0x3f800000n, b: 1n, csr: 0x1f80, after: 0x1f82, value: 1n },
          { code: 'f30f5dc1', a: 0x3f800000n, b: 1n, csr: 0x1fc0, after: 0x1fc0, value: 0n },
          { code: 'f30f2cc1', b: 0xcf000000n, csr: 0x1f80, after: 0x1f80, gpr: 0x80000000n },
          { code: 'f30f2cc1', b: 0x4f000000n, csr: 0x1f80, after: 0x1f81, gpr: 0x80000000n },
          {
            code: 'f30f2cc1',
            b: 0x4f000000n,
            csr: 0x1f00,
            after: 0x1f01,
            raised: 1,
            stage: 'pre-computation',
          },
          {
            code: 'f20f2dc1',
            b: 0x41dfffffffe00000n,
            width: 64,
            csr: 0x1f80,
            after: 0x1f81,
            gpr: 0x80000000n,
          },
          {
            code: 'f20f2dc1',
            b: 0x41dfffffffe00000n,
            width: 64,
            csr: 0x7f80,
            after: 0x7fa0,
            gpr: 0x7fffffffn,
          },
          {
            code: 'f30f5ac1',
            b: 0x7f800001n,
            csr: 0x1f80,
            after: 0x1f81,
            value: 0x7ff8000020000000n,
            width: 64,
          },
          {
            code: 'f20f5ac1',
            b: 0x7ff0000000000001n,
            csr: 0x1f80,
            after: 0x1f81,
            value: 0x7fc00000n,
            width: 32,
          },
          {
            code: '0f2fc1',
            a: 0x7fc00011n,
            b: 0x3f800000n,
            csr: 0x1f80,
            after: 0x1f81,
            flags: 0x447n,
          },
          {
            code: '0f2ec1',
            a: 0x7fc00011n,
            b: 0x3f800000n,
            csr: 0x1f80,
            after: 0x1f80,
            flags: 0x447n,
          },
          {
            code: '0f2fc1',
            a: 0x7fc00011n,
            b: 0x3f800000n,
            csr: 0x1f00,
            after: 0x1f01,
            raised: 1,
            stage: 'pre-computation',
          },
          {
            code: '0f2ec1',
            a: 0x7fc00011n,
            b: 0x3f800000n,
            csr: 0x1f00,
            after: 0x1f00,
            flags: 0x447n,
          },
        ];
        for (const p of packets)
          await using(compiler, p.code, LONG, async (cpu) => {
            const raw = banks(),
              before = input(0x1000n, {}, 0xcd7n);
            raw[0] = (raw[0]! & ~0xffffffffn) | (p.a ?? 0x3f800000n);
            // Source conversions can read64 bits even when their result is32 bits.
            raw[1] = (raw[1]! & ~0xffffffffffffffffn) | p.b;
            const expected = raw.slice(),
              updates: Record<number, bigint> = {};
            if (p.value !== undefined) {
              const width = p.width ?? 32,
                mask = (1n << BigInt(width)) - 1n;
              expected[0] = (raw[0]! & ~mask) | p.value;
            }
            if (p.gpr !== undefined) updates[0] = p.gpr;
            cpu.setState(before);
            cpu.setXmmState(raw);
            cpu.setMxcsr(p.csr);
            const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
            outcome(
              result,
              p.raised ? 'simd-exception' : 'budget',
              1n,
              p.raised ? 0n : 1n,
              0n,
              0n,
              p.raised
                ? before
                : changed(
                    before,
                    0x1000n + BigInt(p.code.length / 2),
                    updates,
                    p.flags ?? before.flags,
                  ),
            );
            xmm(cpu, expected);
            mxcsr(cpu, p.after);
            if (p.raised)
              simdFault(result, p.csr, p.after, p.raised, p.raised & ~(p.csr >>> 7) & 63, p.stage!);
            else noFault(result);
          });
      },
    },
    {
      name: 'floating packed pre-computation faults suppress later lane status and entire destination publication',
      async run() {
        const a = vector([0n, 0x3f800000n, 0x7f7fffffn, 0x3f800000n], 32),
          b = vector([0n, 0n, 0x3f000000n, 0x40400000n], 32);
        await using(compiler, '0f5ec1', LONG, async (cpu) => {
          const before = input(0x1000n, {}, 0xcd7n),
            raw = banks();
          raw[0] = a;
          raw[1] = b;
          cpu.setState(before);
          cpu.setXmmState(raw);
          cpu.setMxcsr(0x1f00);
          const failed = await cpu.run({ budget: 1n, repeatBudget: 0n });
          outcome(failed, 'simd-exception', 1n, 0n, 0n, 0n, before);
          simdFault(failed, 0x1f00, 0x1f05, 5, 1, 'pre-computation');
          mxcsr(cpu, 0x1f05);
          xmm(cpu, raw);
          cpu.setMxcsr(0x1f85);
          const repaired = await cpu.run({ budget: 1n, repeatBudget: 0n });
          outcome(repaired, 'budget', 1n, 1n, 0n, 0n, changed(before, 0x1003n));
          const after = raw.slice();
          after[0] = vector([0xffc00000n, 0x7f800000n, 0x7f800000n, 0x3eaaaaabn], 32);
          xmm(cpu, after);
          mxcsr(cpu, 0x1fad);
          noFault(repaired);
          equal(repaired.resources.compilations, 0, 'mask repair reuses executable owner');
        });
      },
    },
    {
      name: 'floating scalar arithmetic ignores exceptional inactive lanes while packed arithmetic observes them',
      async run() {
        for (const scalar of [false, true])
          await using(compiler, scalar ? 'f30f58c1' : '0f58c1', LONG, async (cpu) => {
            const raw = banks(),
              before = input();
            raw[0] = (MASK128 & ~0xffffffffn) | 0x3f800000n;
            raw[1] = vector([0n, 0x7f800001n, 0x7fc00000n, 1n], 32);
            cpu.setState(before);
            cpu.setXmmState(raw);
            cpu.setMxcsr(0x1f00);
            const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
            outcome(
              result,
              scalar ? 'budget' : 'simd-exception',
              1n,
              scalar ? 1n : 0n,
              0n,
              0n,
              scalar ? changed(before, 0x1004n) : before,
            );
            if (scalar) {
              xmm(cpu, raw);
              mxcsr(cpu, 0x1f00);
              noFault(result);
            } else {
              xmm(cpu, raw);
              equal((cpu.readMxcsr() & 1) !== 0, true, 'packed active SNaN raises invalid');
            }
          });
      },
    },
  ];
}
