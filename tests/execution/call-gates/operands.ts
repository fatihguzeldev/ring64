import {
  usingGate,
  initial,
  complete,
  equal,
  same,
  put,
  codeDescriptor,
  gateDescriptor,
  SOURCE,
  TARGET,
  GDT,
  RAM_SIZE,
  type Scenario,
} from './fixture.js';
import { snapshot, using } from '../far-control/fixture.js';

const RWX = { read: true, write: true, execute: true };

export function gateOperandScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'call gate looking selectors in real and v8086 perform literal far transfers without reading inaccessible GDT metadata',
      async run() {
        for (const mode of ['real', 'virtual8086'] as const) {
          const context = snapshot(mode, 0, true, true);
          context.gdtr = { base: 0x300000n, limit: 0x7f };
          const code = mode === 'real' ? '9a341200003b00' : '9a34123b00';
          await using(
            compiler,
            code,
            context,
            async (cpu) => {
              cpu.setState(initial(SOURCE, { 4: 0x8000n }, mode === 'virtual8086' ? 0x3002n : 2n));
              const result = await cpu.run({ budget: 1n });
              complete(result);
              equal(result.state.rip, 0x1234n, 'literal pointer offset, not a gate offset');
              equal(cpu.readContext().segments.cs.selector, 0x3b, 'literal source selector');
              equal(cpu.readContext().segments.cs.base, 0x3b0n, 'real selector base');
              equal(result.systemMemoryFault, undefined, 'gate lookup not attempted');
            },
            { data: [{ base: 0x7ff0n, bytes: 'a5'.repeat(16) }] },
          );
        }
      },
    },
    {
      name: 'call gate memory pointer width captures every offset and selector byte even though the offset value is ignored',
      async run() {
        for (const width of [16, 32, 64] as const)
          for (const missingTail of [false, true])
            await usingGate(
              compiler,
              {
                mode: width === 64 ? 'long64' : 'protected',
                pointerWidth: width,
                code: (width === 16 ? '66' : width === 64 ? '48' : '') + 'ff1b',
                prepare(memory) {
                  put(memory, 0x5000, width === 64 ? 0x800000000000n : 0xffffffffn, width / 8);
                  put(memory, 0x5000 + width / 8, 0x3bn, 2);
                },
              },
              async (cpu) => {
                const length = width / 8 + 2;
                if (missingTail)
                  cpu.setMappings([
                    {
                      base: 0n,
                      backing: 'ram',
                      offset: 0,
                      length: 0x5000 + length - 1,
                      permissions: RWX,
                    },
                    {
                      base: 0x5000n + BigInt(length),
                      backing: 'ram',
                      offset: 0x5000 + length,
                      length: RAM_SIZE - 0x5000 - length,
                      permissions: RWX,
                    },
                  ]);
                cpu.setState(initial(SOURCE, { 3: 0x5000n, 4: 0x4000n }));
                const result = await cpu.run({ budget: 1n });
                if (missingTail) {
                  equal(
                    result.reason,
                    'data-fault',
                    'selector tail is required before gate classification',
                  );
                  equal(result.fault?.address, 0x5000n, 'entire captured pointer starts here');
                  equal(result.fault?.width, length, 'source width owns pointer extent');
                  equal(
                    result.fault?.failingAddress,
                    0x5000n + BigInt(length - 1),
                    'last mandatory byte',
                  );
                  equal(result.fault?.segment, 'ds', 'explicit operand segment');
                  equal(result.systemMemoryFault, undefined, 'descriptor path not reached');
                  equal(result.retired, 0n, 'no partial gate');
                } else {
                  complete(result);
                  equal(
                    result.state.rip,
                    TARGET,
                    'unusable raw operand offset is ignored after gate selection',
                  );
                }
              },
            );
      },
    },
    {
      name: 'call gate FS operand ownership never leaks to supervisor GDT TSS or destination stack selection',
      async run() {
        await usingGate(
          compiler,
          {
            code: '64ff1b',
            count: 1,
            prepare(memory, context) {
              context.segments.fs.base = 0x5000n;
              put(memory, 0x5000, 0xffffffffn, 4);
              put(memory, 0x5004, 0x3bn, 2);
            },
          },
          async (cpu) => {
            const fs = cpu.readContext().segments.fs;
            cpu.setState(initial(SOURCE, { 3: 0n, 4: 0x4000n }));
            complete(await cpu.run({ budget: 1n }));
            equal(cpu.readState().registers[4], 0x8fecn, 'new SS destination has base zero');
            same(cpu.readContext().segments.fs, fs, 'retained nonzero source FS cache');
            equal(cpu.readMemory(0x8fecn, 1)[0], 3, 'saved PC is source1003, not offset-adjusted');
          },
        );
      },
    },
    {
      name: 'call gate legacy whole eight-byte extent and gate16 ignored high offset do not acquire 64-bit rules',
      async run() {
        for (const width of [16, 32] as const)
          await usingGate(
            compiler,
            {
              gateWidth: width,
              prepare(memory, context) {
                context.gdtr.limit = 0x3f;
                if (width === 16) {
                  memory.set(gateDescriptor(16, 0xe0, TARGET, 0x0b), Number(GDT) + 0x38);
                  put(memory, Number(GDT) + 0x3e, 0xabcdn, 2);
                  memory.set(codeDescriptor(16, 0), Number(GDT) + 8);
                }
              },
            },
            async (cpu) => {
              cpu.setState(initial(SOURCE, { 4: 0x4000n }));
              complete(await cpu.run({ budget: 1n }));
              equal(
                cpu.readState().rip,
                TARGET,
                'gate16 unused high offset and count high bits ignored',
              );
              equal(
                cpu.readState().registers[4],
                width === 16 ? 0x8ff8n : 0x8ff0n,
                'zero low-five-bit count only',
              );
            },
          );
      },
    },
    {
      name: 'call gate GDT full sixteen-byte extent cannot wrap selector fff8 into table entry zero',
      async run() {
        await usingGate(
          compiler,
          {
            mode: 'long64',
            prepare(memory, context) {
              context.gdtr = { base: 0x10000n, limit: 0xffff };
              memory.set(gateDescriptor(64).slice(0, 8), 0x1fff8);
              put(memory, 0x5004, 0xfffbn, 2);
            },
          },
          async (cpu) => {
            cpu.setState(initial(SOURCE, { 3: 0x5000n, 4: 0x4000n }));
            const result = await cpu.run({ budget: 1n });
            equal(result.reason, 'protection-fault', 'selected gate exceeds GDTffff limit');
            equal(result.protectionFault?.vector, 13, 'GP extent');
            equal(result.protectionFault?.errorCode, 0xfff8, 'original index retained');
            equal(result.systemMemoryFault, undefined, 'tail beyond extent was not read');
          },
        );
      },
    },
  ];
}
