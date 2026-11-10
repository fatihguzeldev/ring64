import {
  using,
  snapshot,
  initial,
  loadedCode,
  loadedData,
  withGate,
  gate,
  CODE16,
  CODE32,
  CODE64,
  DATA16,
  DATA32,
  STACK,
  FILL,
  image,
  encoded,
  same,
  equal,
  ready,
  delivery,
  type Scenario,
} from './fixture.js';

export function modeScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'real and protected16 processor entry use fixed or gate-width frames without an architectural error slot',
      async run() {
        for (const real of [true, false]) {
          const execution = snapshot(real ? 'real' : 'protected', 0, false, false);
          if (!real) {
            execution.segments.cs = loadedCode(16);
            execution.segments.ss = loadedData(16);
          }
          const address = withGate(execution, 6);
          await using(
            compiler,
            '0f0b',
            execution,
            async (cpu) => {
              cpu.setState(initial(0x1000n, { 4: 0x11223344abcd8000n }, 0x202n));
              const result = await cpu.run({
                budget: 1n,
                stop: 0x2000n,
                exceptionDelivery: { budget: 1n },
              });
              delivery(result, 'stop', 0n, 1n, 0n);
              ready(result);
              equal(
                result.state.registers[4],
                0x11223344abcd7ffan,
                'SP16 frame preserves raw high bits',
              );
              same(
                cpu.readMemory(0x7ffan, 6),
                image([0x1000n, real ? 0n : 8n, 0x202n], 2),
                'six-byte frame truncates saved RF',
              );
              equal(result.state.flags, 2n, 'handler live flags use real/protected entry rules');
            },
            {
              data: [
                ...(!real ? [{ base: 0x4008n, bytes: CODE16 + DATA16 }] : []),
                {
                  base: address,
                  bytes: real ? encoded(image([0x2000n, 0n], 2)) : gate(16, 8, 0x2000n, 0),
                },
                { base: STACK, bytes: FILL },
              ],
            },
          );
        }
      },
    },
    {
      name: 'compatibility exception enters long64 and IRETQ restores the source code size and captured RF image',
      async run() {
        for (const code32 of [false, true]) {
          const execution = snapshot('compatibility', 0, code32, true);
          execution.segments.cs = loadedCode(code32 ? 32 : 16, 0x18);
          execution.segments.ss = loadedData(32);
          const address = withGate(execution, 6);
          await using(
            compiler,
            '0f0b90',
            execution,
            async (cpu) => {
              cpu.setState(initial(0x1000n, { 4: 0x8000n }, 0x202n));
              const entered = await cpu.run({
                budget: 1n,
                stop: 0x2000n,
                exceptionDelivery: { budget: 1n },
              });
              delivery(entered, 'stop', 0n, 1n, 0n);
              equal(cpu.readContext().mode, 'long64', '64-bit handler context');
              same(
                cpu.readMemory(0x7fd8n, 40),
                image([0x1000n, 0x18n, 0x10202n, 0x8000n, 16n], 8),
                'compatibility source uses five qword slots',
              );
              // A #UD handler may deliberately skip the selected faulting instruction.
              cpu.writeMemory(0x7fd8n, image([0x1002n], 8));
              const returned = await cpu.run({ budget: 1n, exceptionDelivery: { budget: 1n } });
              delivery(returned, 'budget', 1n, 0n, 1n);
              ready(returned);
              same(cpu.readContext(), execution, 'complete compatibility context restored');
              equal(returned.state.rip, 0x1002n, 'edited return PC is honored');
              equal(returned.state.flags, 0x10202n, 'returned RF survives IRETQ');
              equal(returned.state.registers[4], 0x8000n, 'raw source stack restored');
              const next = await cpu.run({ budget: 1n });
              equal(next.state.rip, 0x1003n, 'continuation uses restored code size');
              equal(next.state.flags, 0x202n, 'ordinary continuation consumes RF');
            },
            {
              data: [
                { base: 0x4008n, bytes: CODE64 + DATA32 + (code32 ? CODE32 : CODE16) },
                { base: address, bytes: gate(64, 8, 0x2000n, 0) },
                { base: 0x2000n, bytes: '48cf', execute: true },
                { base: STACK, bytes: FILL },
              ],
            },
          );
        }
      },
    },
    {
      name: 'processor exceptions bypass gate DPL and consume live inner or IST stacks with exact qword frames',
      async run() {
        for (const [cpl, ist] of [
          [3, 0],
          [0, 1],
          [0, 7],
        ] as const) {
          const execution = snapshot('long64', cpl);
          execution.segments.cs = loadedCode(64, 0x18 | cpl, cpl);
          execution.segments.ss = loadedData(32, 0x20 | cpl, cpl);
          execution.tr = {
            selector: 0x28,
            valid: true,
            base: 0x5000n,
            limit: 0x67,
            attributes: 0x8b,
          };
          const address = withGate(execution, 6);
          const field = 0x5000n + BigInt(ist ? 36 + 8 * (ist - 1) : 4);
          await using(
            compiler,
            '0f0b',
            execution,
            async (cpu) => {
              const rawSp = 0x123456780000800bn;
              cpu.setState(initial(0x1000n, { 4: rawSp }, 0x202n));
              const result = await cpu.run({
                budget: 1n,
                stop: 0x2000n,
                exceptionDelivery: { budget: 1n },
              });
              delivery(result, 'stop', 0n, 1n, 0n);
              ready(result);
              equal(result.state.registers[4], 0x7f58n, 'selected stack aligned before frame');
              same(
                cpu.readMemory(0x7f58n, 40),
                image([0x1000n, BigInt(0x18 | cpl), 0x10202n, rawSp, BigInt(0x20 | cpl)], 8),
                'inner/IST frame includes raw old stack',
              );
              equal(cpu.readContext().cpl, 0, 'handler CPL');
              equal(cpu.readContext().segments.ss.selector, 0, 'stack switch selects null SS');
              equal(cpu.readContext().segments.ss.usable, false, 'null SS raw-cache policy');
              same(cpu.readContext().tr, execution.tr, 'selected live TSS does not reload TR');
            },
            {
              data: [
                { base: 0x4008n, bytes: CODE64 + DATA32 },
                { base: address, bytes: gate(64, 8, 0x2000n, 0, false, ist) },
                { base: field, bytes: encoded(image([0x7f8bn], 8)) },
                { base: STACK, bytes: FILL },
              ],
            },
          );
        }
      },
    },
    {
      name: 'virtual8086 privilege fault delivers through a DPL0 gate and its tenth slot returns through repaired IOPL',
      async run() {
        const execution = snapshot('virtual8086');
        for (const [index, name] of ['cs', 'ss', 'es', 'ds', 'fs', 'gs'].entries()) {
          const key = name as 'cs' | 'ss' | 'es' | 'ds' | 'fs' | 'gs';
          execution.segments[key].selector = (index + 1) * 0x1000;
          execution.segments[key].base = BigInt(index + 1) << 16n;
        }
        execution.tr = {
          selector: 0x28,
          valid: true,
          base: 0x5000n,
          limit: 0x67,
          attributes: 0x8b,
        };
        const address = withGate(execution, 13);
        await using(
          compiler,
          'fa90',
          execution,
          async (cpu) => {
            cpu.setState(initial(0x1000n, { 4: 0x11223344abcd7020n }, 0x202n));
            const result = await cpu.run({
              budget: 1n,
              stop: 0x2000n,
              exceptionDelivery: { budget: 1n },
            });
            delivery(result, 'stop', 0n, 1n, 0n);
            ready(result);
            const values = [
              0n,
              0x1000n,
              0x1000n,
              0x30202n,
              0xabcd7020n,
              0x2000n,
              0x3000n,
              0x4000n,
              0x5000n,
              0x6000n,
            ];
            same(cpu.readMemory(0x7f58n, 40), image(values, 4), 'tenth-slot VM fault frame');
            equal(cpu.readContext().mode, 'protected', 'processor entry leaves VM context');
            equal(cpu.readContext().cpl, 0, 'VM exception handler must be CPL0');
            for (const key of ['es', 'ds', 'fs', 'gs'] as const) {
              equal(cpu.readContext().segments[key].selector, 0, `cleared ${key} selector`);
              equal(cpu.readContext().segments[key].usable, false, `cleared ${key} cache`);
            }
            cpu.writeMemory(0x7f64n, image([0x33202n], 4));
            const retry = await cpu.run({ budget: 3n, exceptionDelivery: { budget: 1n } });
            delivery(retry, 'budget', 3n, 0n, 1n);
            equal(retry.state.rip, 0x1001n, 'CLI retried in virtual8086 after IRET');
            equal(retry.state.flags, 0x3002n, 'repaired IOPL permits CLI and RF is consumed');
            equal(cpu.readContext().mode, 'virtual8086', 'context owns restored VM');
            equal(cpu.readContext().segments.cs.selector, 0x1000, 'VM CS restored');
            equal(cpu.readContext().segments.gs.selector, 0x6000, 'final VM segment restored');
          },
          {
            codeBase: 0x11000n,
            data: [
              { base: 0x4008n, bytes: CODE32 + DATA32 },
              { base: address, bytes: gate(32, 8, 0x2000n, 0) },
              { base: 0x5004n, bytes: encoded(image([0x7f80n], 4)) + '1000' },
              { base: 0x2000n, bytes: '83c404cf', execute: true },
              { base: STACK, bytes: FILL },
            ],
          },
        );
      },
    },
    {
      name: 'virtual8086 processor gate16 remains a repairable unsupported frontier before unselected code or TSS access',
      async run() {
        const execution = snapshot('virtual8086');
        const address = withGate(execution, 6);
        await using(
          compiler,
          '0f0b',
          execution,
          async (cpu) => {
            cpu.setState(initial(0x1000n, { 4: 0x8000n }, 0x202n));
            const result = await cpu.run({ budget: 1n, exceptionDelivery: { budget: 1n } });
            delivery(result, 'unsupported', 0n, 1n, 0n);
            same(
              result.state.event,
              {
                kind: 'pending',
                exception: {
                  vector: 6,
                  instructionPc: 0x1000n,
                  returnPc: 0x1000n,
                  savedFlags: 0x30202n,
                },
              },
              'excluded gate retains original event instead of fabricating #GP',
            );
            equal(result.systemMemoryFault, undefined, 'unselected code/TSS not fetched');
            equal(result.protectionFault, undefined, 'no invented architectural rejection');
          },
          { data: [{ base: address, bytes: gate(16, 8, 0x2000n, 0) }] },
        );
      },
    },
  ];
}
