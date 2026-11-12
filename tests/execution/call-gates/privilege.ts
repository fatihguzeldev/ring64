import {
  usingGate,
  initial,
  complete,
  equal,
  same,
  read,
  scalar,
  put,
  gateDescriptor,
  codeDescriptor,
  dataDescriptor,
  SOURCE,
  TARGET,
  GDT,
  TSS,
  OLD_SP,
  NEW_SP,
  type ExecutionContextSnapshot,
  type Scenario,
} from './fixture.js';

export function privilegeScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'call gate same CPL conforming and JMP never read an unselected TSS or copy parameters',
      async run() {
        for (const width of [16, 32] as const)
          for (const kind of ['same', 'conforming', 'jump', 'conforming-jump'] as const) {
            const jump = kind.endsWith('jump');
            const conforming = kind.startsWith('conforming');
            await usingGate(
              compiler,
              {
                gateWidth: width,
                count: 31,
                targetCpl: conforming ? 0 : 3,
                conforming,
                code: (jump ? 'ea' : '9a') + 'ffffffff3b00',
                prepare(_memory, context) {
                  context.tr.valid = false;
                },
              },
              async (cpu) => {
                const before = initial(SOURCE, { 4: OLD_SP }, 0x602n);
                cpu.setState(before);
                const ss = cpu.readContext().segments.ss;
                const old = read(cpu, OLD_SP - 16n, 32);
                const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
                complete(result);
                equal(result.state.rip, TARGET, 'operand offset ignored');
                equal(cpu.readContext().cpl, 3, 'source CPL retained');
                equal(
                  cpu.readContext().segments.cs.selector,
                  0x0b,
                  'target selector RPL uses retained CPL',
                );
                same(cpu.readContext().segments.ss, ss, 'entire unchanged SS cache');
                equal(
                  result.state.registers[4],
                  jump ? OLD_SP : OLD_SP - BigInt(width / 4),
                  'exactly two CALL slots or none for JMP',
                );
                if (jump) same(read(cpu, OLD_SP - 16n, 32), old, 'JMP performs no stack traffic');
                else {
                  equal(
                    scalar(cpu, OLD_SP - BigInt(width / 4), width / 8),
                    0x1007n,
                    'complete next PC',
                  );
                  equal(scalar(cpu, OLD_SP - BigInt(width / 8), width / 8), 0x1bn, 'old CS only');
                }
                equal(result.state.flags, 0x602n, 'IF and DF preserved');
              },
            );
          }
      },
    },
    {
      name: 'call gate fault priority retains selected gate target TSS and new SS identities without publication',
      async run() {
        const cases: {
          name: string;
          vector: number;
          error: number;
          change(memory: Uint8Array, context: ExecutionContextSnapshot): void;
        }[] = [
          {
            name: 'gate DPL before absent',
            vector: 13,
            error: 0x38,
            change(memory) {
              memory[Number(GDT) + 0x3d] = 0x4c;
            },
          },
          {
            name: 'gate absent',
            vector: 11,
            error: 0x38,
            change(memory) {
              memory[Number(GDT) + 0x3d] = 0x6c;
            },
          },
          {
            name: 'target selector null before invalid TR',
            vector: 13,
            error: 0,
            change(memory, context) {
              put(memory, Number(GDT) + 0x3a, 0n, 2);
              context.tr.valid = false;
            },
          },
          {
            name: 'target absent before invalid TR',
            vector: 11,
            error: 8,
            change(memory, context) {
              memory[Number(GDT) + 13] = 0x1b;
              context.tr.valid = false;
            },
          },
          {
            name: 'invalid TR before target offset',
            vector: 10,
            error: 0x28,
            change(memory, context) {
              context.tr.valid = false;
              memory.set(gateDescriptor(32, 1, 0x100000n), Number(GDT) + 0x38);
              memory.set(codeDescriptor(16, 0), Number(GDT) + 8);
            },
          },
          {
            name: 'complete TSS field limit before reads',
            vector: 10,
            error: 0x28,
            change(_memory, context) {
              context.tr.limit = 8;
              context.tr.base = 0x300000n;
            },
          },
          {
            name: 'new SS null',
            vector: 10,
            error: 0,
            change(memory) {
              put(memory, Number(TSS) + 8, 0n, 2);
            },
          },
          {
            name: 'new SS wrong RPL',
            vector: 10,
            error: 0x10,
            change(memory) {
              put(memory, Number(TSS) + 8, 0x13n, 2);
            },
          },
          {
            name: 'new SS wrong DPL',
            vector: 10,
            error: 0x10,
            change(memory) {
              memory.set(dataDescriptor(32, 3), Number(GDT) + 0x10);
            },
          },
          {
            name: 'new SS code type',
            vector: 10,
            error: 0x10,
            change(memory) {
              memory.set(codeDescriptor(32, 0), Number(GDT) + 0x10);
            },
          },
          {
            name: 'new SS absent',
            vector: 12,
            error: 0x10,
            change(memory) {
              memory[Number(GDT) + 0x15] = 0x13;
            },
          },
          {
            name: 'new SS limit before target offset',
            vector: 12,
            error: 0x10,
            change(memory) {
              memory.set(dataDescriptor(32, 0), Number(GDT) + 0x10);
              memory[Number(GDT) + 0x16] = 0x40;
              put(memory, Number(TSS) + 4, 0x10004n, 4);
              memory.set(gateDescriptor(32, 1, 0x100000n), Number(GDT) + 0x38);
              memory.set(codeDescriptor(16, 0), Number(GDT) + 8);
            },
          },
          {
            name: 'target offset before parameter read',
            vector: 13,
            error: 0,
            change(memory, context) {
              memory.set(gateDescriptor(32, 1, 0x100000n), Number(GDT) + 0x38);
              memory.set(codeDescriptor(16, 0), Number(GDT) + 8);
              context.segments.ss.limit = 0x3fff;
            },
          },
        ];
        for (const item of cases)
          await usingGate(compiler, { count: 1, prepare: item.change }, async (cpu) => {
            const context = cpu.readContext();
            const frame = read(cpu, NEW_SP - 32n, 32);
            const before = initial(SOURCE, { 4: OLD_SP }, 0x10202n);
            cpu.setState(before);
            const result = await cpu.run({ budget: 1n });
            equal(result.reason, 'protection-fault', item.name);
            equal(result.protectionFault?.vector, item.vector, `${item.name} vector`);
            equal(result.protectionFault?.errorCode, item.error, `${item.name} selector code`);
            equal(result.retired, 0n, 'failed selected gate');
            same(result.state.registers, before.registers, 'all raw banks retained');
            equal(result.state.rip, SOURCE, 'no target publication');
            equal(result.state.flags, 0x202n, 'only begin clears RF');
            same(cpu.readContext(), context, 'no partial loaded cache publication');
            same(read(cpu, NEW_SP - 32n, 32), frame, 'no private frame payload');
          });
      },
    },
    {
      name: 'call gate TSS reads selector field before pointer field and count0 omits old parameter access',
      async run() {
        await usingGate(
          compiler,
          {
            family: 'legacy32',
            count: 1,
            prepare(memory, context) {
              context.tr.base = 0x7ff8n;
              put(memory, 0x19000 + 7 * 4, 0n, 4);
              put(memory, 0x19000 + 8 * 4, 0n, 4);
            },
          },
          async (cpu) => {
            cpu.setState(initial(SOURCE, { 4: OLD_SP }));
            const result = await cpu.run({ budget: 1n });
            equal(result.reason, 'page-fault', 'selected TSS selector read');
            equal(result.pageFault?.address, 0x8000n, 'SS field first, not earlier ESP address');
            equal(result.pageFault?.access, 'read', 'TSS field is metadata read');
            equal(result.retired, 0n, 'no half frame');
          },
        );
        await usingGate(
          compiler,
          {
            family: 'legacy32',
            count: 0,
            prepare(memory) {
              put(memory, 0x19000 + 4 * 4, 0n, 4);
            },
          },
          async (cpu) => {
            cpu.setState(initial(SOURCE, { 4: OLD_SP }));
            complete(await cpu.run({ budget: 1n }));
            equal(cpu.readState().registers[4], 0x8ff0n, 'four fixed slots only');
          },
        );
      },
    },
    {
      name: 'call gate target RPL is ignored and JMP cannot enter a lower nonconforming privilege',
      async run() {
        for (const jump of [false, true])
          await usingGate(
            compiler,
            {
              code: (jump ? 'ea' : '9a') + '000000003b00',
              prepare(memory) {
                put(memory, Number(GDT) + 0x3a, 0x0bn, 2);
              },
            },
            async (cpu) => {
              cpu.setState(initial(SOURCE, { 4: OLD_SP }));
              const result = await cpu.run({ budget: 1n });
              if (jump) {
                equal(result.reason, 'protection-fault', 'nonconforming inner JMP');
                equal(result.protectionFault?.vector, 13, 'GP');
                equal(result.protectionFault?.errorCode, 8, 'embedded selector masked');
              } else {
                complete(result);
                equal(
                  cpu.readContext().segments.cs.selector,
                  8,
                  'embedded RPL cannot retain caller privilege',
                );
                equal(cpu.readContext().cpl, 0, 'selected DPL admits inner CALL');
              }
            },
          );
      },
    },
  ];
}
