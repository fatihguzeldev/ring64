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
  bytes,
  memory,
  equal,
  noFault,
  hex,
  type Scenario,
} from './fixture.js';

export function maskScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'masked stores select only each byte sign bit and preserve physical raw80 sources and environment',
      async run() {
        for (const [code, width, mask, expected] of [
          ['0ff7c1', 8, 0x800001007f010180n, '10a5a5a5a5a5a517'],
          ['660ff7c1', 16, 0x80017f00017f0100800001007f010180n, '10a5a5a5a5a5a517a5a5a5a5a5a5a51f'],
        ] as const)
          await using(
            compiler,
            code,
            LONG,
            async (cpu) => {
              const before = input(0x1000n, { 7: 0x6001n }, 0xcd7n),
                numeric = stack({}, 5, 0x37f, 0x4700),
                vector = banks();
              numeric.registers[0] = (0x1234n << 64n) | (DATA & MASK64);
              numeric.registers[1] = (0xabcdn << 64n) | (mask & MASK64);
              vector[0] = DATA;
              vector[1] = mask;
              cpu.setState(before);
              seed(cpu, numeric);
              cpu.setXmmState(vector);
              const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
              outcome(
                result,
                'budget',
                1n,
                1n,
                0n,
                0n,
                changed(before, 0x1000n + BigInt(code.length / 2)),
              );
              noFault(result);
              x87(cpu, width === 8 ? transition(numeric) : numeric);
              xmm(cpu, vector);
              equal(cpu.readMxcsr(), 0xffc5, 'mask store does not classify numeric payloads');
              memory(cpu, 0x6000n, 'a5' + expected + 'a5');
            },
            { data: [{ base: 0x6000n, bytes: 'a5'.repeat(width + 2) }] },
          );
      },
    },
    {
      name: 'masked data and mask aliases snapshot the same physical MMX or XMM source before publication',
      async run() {
        for (const [code, width, value, expected] of [
          ['0ff7c0', 8, 0x807fff0180007f80n, '80a5a580a5ffa580'],
          ['660ff7c0', 16, 0x7f800100ff807f01807fff0180007f80n, '80a5a580a5ffa580a5a580ffa5a580a5'],
        ] as const)
          await using(
            compiler,
            code,
            LONG,
            async (cpu) => {
              const before = input(0x1000n, { 7: 0x6000n }),
                numeric = stack({}, 5),
                vector = banks();
              numeric.registers[0] = (0x4321n << 64n) | (value & MASK64);
              vector[0] = value;
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
              x87(cpu, width === 8 ? transition(numeric) : numeric);
              xmm(cpu, vector);
              noFault(result);
              memory(cpu, 0x6000n, expected);
            },
            { data: [{ base: 0x6000n, bytes: 'a5'.repeat(width) }] },
          );
      },
    },
    {
      name: 'masked implicit DI addressing obeys all fourteen profiles and overrides without changing index or count',
      async run() {
        for (const p of profiles)
          for (const override of [false, true])
            for (const width of [8, 16]) {
              const code = (override ? '67' : '') + (width === 8 ? '0ff7c1' : '660ff7c1');
              const execution = p.mode === 'long64' ? LONG : context(p.mode, p.code32, p.stack32);
              await using(
                compiler,
                code,
                execution,
                async (cpu) => {
                  const before = input(0x1000n, {
                    7: p.mode === 'long64' && !override ? 0x6000n : 0x123400006000n,
                    15: 0x7000n,
                    1: 0n,
                  });
                  const numeric = stack({}, 5),
                    vector = banks();
                  numeric.registers[0] = DATA & MASK64;
                  numeric.registers[1] = MASK64;
                  vector[0] = DATA;
                  vector[1] = (1n << 128n) - 1n;
                  cpu.setState(before);
                  seed(cpu, numeric);
                  cpu.setXmmState(vector);
                  const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
                  outcome(
                    result,
                    'budget',
                    1n,
                    1n,
                    0n,
                    0n,
                    changed(before, 0x1000n + BigInt(code.length / 2)),
                  );
                  noFault(result);
                  x87(cpu, width === 8 ? transition(numeric) : numeric);
                  xmm(cpu, vector);
                  memory(cpu, 0x6000n, bytes(DATA, width));
                  memory(cpu, 0x7000n, '5a'.repeat(width));
                },
                {
                  data: [
                    { base: 0x6000n, bytes: 'a5'.repeat(width) },
                    { base: 0x7000n, bytes: '5a'.repeat(width) },
                  ],
                },
              );
            }
      },
    },
    {
      name: 'masked REX source extensions and FS GS bases never redirect implicit RDI to R15',
      async run() {
        for (const [prefix, execution, pointer] of [
          ['64', { mode: 'long64' as const, fsBase: 0x6000n, gsBase: 0x8000n }, 3n],
          ['65', { mode: 'long64' as const, fsBase: 0x8000n, gsBase: 0x6000n }, 3n],
        ] as const)
          await using(
            compiler,
            prefix + '66450ff7c1',
            execution,
            async (cpu) => {
              const before = input(0x1000n, { 7: pointer, 15: 0x7000n }),
                numeric = stack({}, 5),
                vector = banks();
              vector[8] = DATA;
              vector[9] = (1n << 128n) - 1n;
              vector[0] = 0n;
              vector[1] = 0n;
              cpu.setState(before);
              seed(cpu, numeric);
              cpu.setXmmState(vector);
              const result = await cpu.run({ budget: 1n });
              outcome(result, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1006n));
              noFault(result);
              x87(cpu, numeric);
              xmm(cpu, vector);
              memory(cpu, 0x6003n, bytes(DATA));
            },
            { data: [{ base: 0x6003n, bytes: 'a5'.repeat(16) }] },
          );
      },
    },
    {
      name: 'masked stores use W-only split spans and a zero MMX mask still retires the TOP tag transition',
      async run() {
        for (const width of [8, 16])
          for (let split = 1; split < width; split++)
            for (const zero of [false, true]) {
              const code = width === 8 ? '0ff7c1' : '660ff7c1';
              await mapped(
                compiler,
                code,
                [{ id: 'data', bytes: hex('a5'.repeat(width + 4)) }],
                [
                  map(0x6001n, 'data', split, W, 2),
                  map(0x6001n + BigInt(split), 'data', width - split, W, 2 + split),
                  map(0x8000n, 'data', width + 4, R),
                ],
                async (cpu) => {
                  const before = input(0x1000n, { 7: 0x6001n }),
                    numeric = stack({}, 5, 0x37f, 0x4700),
                    vector = banks();
                  numeric.registers[0] = (0x1234n << 64n) | (DATA & MASK64);
                  numeric.registers[1] = zero ? 0n : MASK64;
                  vector[0] = DATA;
                  vector[1] = zero ? 0n : (1n << 128n) - 1n;
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
                  x87(cpu, width === 8 ? transition(numeric) : numeric);
                  xmm(cpu, vector);
                  noFault(result);
                  memory(
                    cpu,
                    0x8000n,
                    'a5a5' + (zero ? 'a5'.repeat(width) : bytes(DATA, width)) + 'a5a5',
                  );
                },
              );
            }
      },
    },
    {
      name: 'masked stores consume dirty generated data and masks and retained middle entries use fresh imports',
      async run() {
        for (const [code, data, mask, expected] of [
          ['660fefc0660ff7c1', DATA, (1n << 128n) - 1n, '00'.repeat(16)],
          ['660fefc9660ff7c1', DATA, (1n << 128n) - 1n, 'a5'.repeat(16)],
        ] as const)
          await using(
            compiler,
            code,
            LONG,
            async (cpu) => {
              const before = input(0x1000n, { 7: 0x6000n }),
                numeric = stack({}, 5),
                vector = banks();
              vector[0] = data;
              vector[1] = mask;
              cpu.setState(before);
              seed(cpu, numeric);
              cpu.setXmmState(vector);
              const first = await cpu.run({ budget: 2n });
              outcome(first, 'budget', 2n, 2n, 2n, 0n, changed(before, 0x1008n));
              memory(cpu, 0x6000n, expected);
              cpu.setState(changed(before, 0x1004n));
              vector[0] = 0xccccccccccccccccccccccccccccccccn;
              vector[1] = 0xffffffffffffffffffffffffffffffffn;
              cpu.setXmmState(vector);
              const second = await cpu.run({ budget: 1n });
              outcome(second, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1008n));
              equal(second.resources.compilations, 0, 'middle-entry code reused');
              memory(cpu, 0x6000n, 'cc'.repeat(16));
              x87(cpu, numeric);
              xmm(cpu, vector);
              noFault(second);
            },
            { data: [{ base: 0x6000n, bytes: 'a5'.repeat(16) }] },
          );
      },
    },
  ];
}
