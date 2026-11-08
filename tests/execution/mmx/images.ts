import {
  LONG,
  context,
  profiles,
  using,
  input,
  changed,
  outcome,
  stack,
  clone,
  x87,
  banks,
  xmm,
  equal,
  bytes,
  memory,
  pending,
  noFault,
  ONE,
  type Scenario,
} from '../x87/fixture.js';

function put(image: Uint8Array, offset: number, value: bigint | number, width: number) {
  let remaining = BigInt(value);
  for (let i = 0; i < width; i++) {
    image[offset + i] = Number(remaining & 255n);
    remaining >>= 8n;
  }
}
function hex(image: Uint8Array) {
  return Array.from(image, (b) => b.toString(16).padStart(2, '0')).join('');
}
function fxImage(
  numeric: ReturnType<typeof stack>,
  vector: bigint[],
  mxcsr: number,
  count = 16,
  wide = true,
) {
  const image = new Uint8Array(512).fill(0xa5);
  put(image, 0, numeric.controlWord, 2);
  put(image, 2, numeric.statusWord, 2);
  let tags = 0;
  for (let i = 0; i < 8; i++) if (((numeric.tagWord >> (2 * i)) & 3) !== 3) tags |= 1 << i;
  put(image, 4, tags, 1);
  put(image, 6, numeric.opcode, 2);
  put(image, 8, numeric.instructionPointer, wide ? 8 : 4);
  put(image, 16, numeric.dataPointer, wide ? 8 : 4);
  if (!wide) {
    put(image, 12, 0, 2);
    put(image, 20, 0, 2);
  }
  put(image, 24, mxcsr, 4);
  put(image, 28, 0xffff, 4);
  const top = (numeric.statusWord >> 11) & 7;
  for (let i = 0; i < 8; i++) put(image, 32 + 16 * i, numeric.registers[(top + i) & 7]!, 10);
  for (let i = 0; i < count; i++) put(image, 160 + 16 * i, vector[i]!, 16);
  return image;
}

export function imageScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'FXSAVE formats emit literal fields and preserve padding tail and nonlong XMM8..15 across every profile',
      async run() {
        for (const p of profiles) {
          const execution = p.mode === 'long64' ? LONG : context(p.mode, p.code32, p.stack32);
          for (const wide of p.mode === 'long64' ? [false, true] : [false]) {
            const code = (wide ? '48' : '') + '0fae' + (p.code32 ? '03' : '07');
            await using(
              compiler,
              code,
              execution,
              async (cpu) => {
                const before = input(0x1000n, { 3: 0x6000n }),
                  numeric = stack({ 0: ONE, 2: 0n }, 5),
                  vector = banks();
                cpu.setState(before);
                cpu.setX87State(numeric);
                cpu.setXmmState(vector);
                cpu.setMxcsr(0xffc5);
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
                memory(
                  cpu,
                  0x6000n,
                  hex(fxImage(numeric, vector, 0xffc5, p.mode === 'long64' ? 16 : 8, wide)),
                );
                x87(cpu, numeric);
                xmm(cpu, vector);
                equal(cpu.readMxcsr(), 0xffc5, 'save preserves MXCSR');
                noFault(result);
              },
              { data: [{ base: 0x6000n, bytes: 'a5'.repeat(512) }] },
            );
          }
        }
      },
    },
    {
      name: 'FXRSTOR normalizes ES B tags and ignores image mask padding and software tail',
      async run() {
        for (const [cw, sw, normalized] of [
          [0x37b, 4, 0x8084],
          [0x37f, 0x8080, 0],
        ] as const) {
          const source = stack({ 0: ONE, 1: 0n }, 5),
            vector = banks();
          source.controlWord = cw;
          source.statusWord = sw | (5 << 11);
          const image = fxImage(source, vector, 0x1f80);
          put(image, 28, 0, 4);
          await using(
            compiler,
            '480fae0b9b',
            LONG,
            async (cpu) => {
              const before = input(0x1000n, { 3: 0x6000n }),
                expected = clone(source);
              expected.statusWord = normalized | (5 << 11);
              cpu.setState(before);
              cpu.setX87State(stack({}, 3));
              cpu.setMxcsr(0xffff);
              const result = await cpu.run({ budget: 1n });
              outcome(result, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1004n));
              x87(cpu, expected);
              xmm(cpu, vector);
              equal(cpu.readMxcsr(), 0x1f80, 'restored MXCSR');
              noFault(result);
              if (cw === 0x37b) {
                const trap = await cpu.run({ budget: 1n });
                pending(trap, expected, 0x1004n);
              }
            },
            { data: [{ base: 0x6000n, bytes: hex(image) }] },
          );
        }
      },
    },
    {
      name: 'failed FXRSTOR preserves dirty SIMD predecessor and every incoming x87 field',
      async run() {
        const image = fxImage(stack({ 0: ONE }, 7), banks(), 0x10000);
        await using(
          compiler,
          '660fefc0480fae0b',
          LONG,
          async (cpu) => {
            const before = input(0x1000n, { 3: 0x6000n }),
              numeric = stack({}, 4),
              vector = banks();
            cpu.setState(before);
            cpu.setX87State(numeric);
            cpu.setXmmState(vector);
            cpu.setMxcsr(0xffc5);
            const result = await cpu.run({ budget: 2n });
            outcome(result, 'general-protection', 2n, 1n, 2n, 0n, changed(before, 0x1004n));
            equal(result.generalProtectionFault?.cause, 'mxcsr-reserved-bits', 'reserved MXCSR');
            equal(result.generalProtectionFault?.loadedValue, 0x10000, 'complete loaded word');
            vector[0] = 0n;
            xmm(cpu, vector);
            x87(cpu, numeric);
            equal(cpu.readMxcsr(), 0xffc5, 'MXCSR rollback');
            memory(cpu, 0x6000n, hex(image));
          },
          { data: [{ base: 0x6000n, bytes: hex(image), write: false }] },
        );
      },
    },
    {
      name: 'FXSAVE sees dirty locals and FXRSTOR updates subsequent SIMD operations in the same unit',
      async run() {
        const source = stack({ 0: ONE }, 5),
          vector = banks(),
          image = fxImage(source, vector, 0x1f80);
        await using(
          compiler,
          '660fefc0480fae03480fae0f660ffcc1',
          LONG,
          async (cpu) => {
            const before = input(0x1000n, { 3: 0x6000n, 7: 0x7000n }),
              numeric = stack({}, 3),
              oldVector = banks();
            cpu.setState(before);
            cpu.setX87State(numeric);
            cpu.setXmmState(oldVector);
            cpu.setMxcsr(0xffc5);
            const result = await cpu.run({ budget: 4n });
            outcome(result, 'budget', 4n, 4n, 4n, 0n, changed(before, 0x1010n));
            oldVector[0] = 0n;
            memory(cpu, 0x6000n, hex(fxImage(numeric, oldVector, 0xffc5)));
            let sum = 0n;
            for (let i = 0; i < 16; i++)
              sum |=
                (((vector[0]! >> BigInt(8 * i)) + (vector[1]! >> BigInt(8 * i))) & 255n) <<
                BigInt(8 * i);
            const expectedVector = vector.slice();
            expectedVector[0] = sum;
            xmm(cpu, expectedVector);
            x87(cpu, source);
            equal(cpu.readMxcsr(), 0x1f80, 'restored control');
          },
          {
            data: [
              { base: 0x6000n, bytes: 'a5'.repeat(512) },
              { base: 0x7000n, bytes: hex(image) },
            ],
          },
        );
      },
    },
    {
      name: 'retained entries after a skipped restore use host state and do not replay the stale image',
      async run() {
        const image = fxImage(stack({ 0: ONE }, 7), Array(16).fill(0n), 0x1f80);
        await using(
          compiler,
          '480fae0b660ffcc1',
          LONG,
          async (cpu) => {
            cpu.setState(input(0x1000n, { 3: 0x6000n }));
            await cpu.run({ budget: 2n });
            const numeric = stack({}, 3),
              vector = Array<bigint>(16).fill(0n),
              before = input(0x1004n);
            vector[0] = 1n;
            vector[1] = 2n;
            cpu.setState(before);
            cpu.setXmmState(vector);
            cpu.setX87State(numeric);
            cpu.setMxcsr(0xffc5);
            const result = await cpu.run({ budget: 1n });
            outcome(result, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1008n));
            equal(result.resources.compilations, 0, 'retained middle entry');
            vector[0] = 3n;
            xmm(cpu, vector);
            x87(cpu, numeric);
            equal(cpu.readMxcsr(), 0xffc5, 'host control retained');
          },
          { data: [{ base: 0x6000n, bytes: hex(image) }] },
        );
      },
    },
    {
      name: 'legacy environment save masks only after success and FNSAVE resets control while preserving physical payloads',
      async run() {
        await using(
          compiler,
          'd933dd339b',
          LONG,
          async (cpu) => {
            const before = input(0x1000n, { 3: 0x6000n }),
              numeric = stack({ 0: ONE }, 5, 0x37b, 0x8084);
            cpu.setState(before);
            cpu.setX87State(numeric);
            const saved = await cpu.run({ budget: 1n });
            outcome(saved, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1002n));
            const masked = clone(numeric);
            masked.controlWord |= 0x3f;
            masked.statusWord &= ~0x8080;
            x87(cpu, masked);
            memory(cpu, 0x6000n, bytes(0x37bn, 2));
            memory(cpu, 0x6004n, bytes(BigInt(numeric.statusWord), 2));
            const reset = await cpu.run({ budget: 1n });
            outcome(reset, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1004n));
            const initialized = stack();
            initialized.registers = masked.registers.slice();
            initialized.instructionPointer = 0n;
            initialized.dataPointer = 0n;
            initialized.opcode = 0;
            x87(cpu, initialized);
            for (let i = 0; i < 8; i++)
              memory(cpu, 0x601cn + BigInt(10 * i), bytes(numeric.registers[(5 + i) & 7]!, 10));
            const wait = await cpu.run({ budget: 1n });
            noFault(wait);
          },
          { data: [{ base: 0x6000n, bytes: 'a5'.repeat(108) }] },
        );
      },
    },
    {
      name: 'image nominal spans fault atomically including unused tail and alignment precedes mapping checks',
      async run() {
        for (const [code, width] of [
          ['d933', 28],
          ['dd33', 108],
          ['480fae03', 512],
        ] as const)
          await using(
            compiler,
            code,
            LONG,
            async (cpu) => {
              const before = input(0x1000n, { 3: 0x6000n }),
                numeric = stack({}, 5, 0x37b, 0x8084);
              cpu.setState(before);
              cpu.setX87State(numeric);
              const result = await cpu.run({ budget: 1n });
              outcome(result, 'data-fault', 1n, 0n, 1n, 0n, before);
              equal(result.fault?.width, width, 'full nominal fault width');
              x87(cpu, numeric);
              memory(cpu, 0x6000n, 'a5'.repeat(width - 1));
            },
            { data: [{ base: 0x6000n, bytes: 'a5'.repeat(width - 1) }] },
          );
        await using(compiler, '480fae03', LONG, async (cpu) => {
          const before = input(0x1000n, { 3: 0x6001n }),
            numeric = stack();
          cpu.setState(before);
          cpu.setX87State(numeric);
          const result = await cpu.run({ budget: 1n });
          outcome(result, 'alignment-fault', 1n, 0n, 1n, 0n, before);
          equal(result.alignmentFault?.width, 512, 'FX nominal alignment width');
          equal(result.alignmentFault?.alignment, 16, 'FX alignment');
          x87(cpu, numeric);
        });
      },
    },
  ];
}
