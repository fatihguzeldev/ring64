import {
  usingGate,
  initial,
  complete,
  equal,
  same,
  scalar,
  little,
  write,
  SOURCE,
  TARGET,
  GDT,
  gateDescriptor,
  RAM_SIZE,
  type Scenario,
} from './fixture.js';

const RWX = { read: true, write: true, execute: true };

export function longGateScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'call gate64 CPL1 CPL2 force their null SS identities and selected RSPn fields through checkpoint and outer return',
      async run() {
        for (const targetCpl of [1, 2])
          for (const mode of ['compatibility', 'long64'] as const)
            await usingGate(
              compiler,
              { family: 'ia32e', mode, targetCpl, newSp: 0x9003n },
              async (cpu) => {
                cpu.setState(initial(SOURCE, { 3: 0x5000n, 4: 0x4000n }));
                const before = cpu.readContext();
                complete(await cpu.run({ budget: 1n }));
                const context = cpu.readContext();
                equal(context.cpl, targetCpl, 'selected inner CPL');
                equal(context.segments.cs.selector, 8 | targetCpl, 'new CS RPL');
                same(
                  context.segments.ss,
                  { ...before.segments.ss, selector: targetCpl, dpl: targetCpl, usable: false },
                  'null SS preserves unrelated hidden fields',
                );
                equal(cpu.readState().registers[4], 0x8fe3n, 'selected unaligned RSPn field');
                cpu.setContext(context);
                cpu.setState(cpu.readState());
                complete(await cpu.run({ budget: 1n }));
                equal(cpu.readContext().cpl, 3, 'outer CPL restored');
                equal(cpu.readContext().segments.ss.selector, 0x23, 'caller SS restored');
                equal(cpu.readState().registers[4], 0x4000n, 'caller raw pointer restored');
              },
            );
      },
    },
    {
      name: 'call gate64 source operand widths and compatibility D use unaligned qword frames and matching outer returns',
      async run() {
        let profile = 0;
        for (const mode of ['compatibility', 'long64'] as const)
          for (const source32 of mode === 'long64' ? [true] : [false, true])
            for (const operand of mode === 'long64' ? ([16, 32, 64] as const) : ([16, 32] as const))
              for (const sameCpl of [false, true]) {
                const family = (['linear', 'ia32e', 'fixed-ia32e'] as const)[profile++ % 3]!;
                const prefix =
                  mode === 'long64'
                    ? operand === 16
                      ? '66'
                      : operand === 64
                        ? '48'
                        : ''
                    : operand === (source32 ? 32 : 16)
                      ? ''
                      : '66';
                const code =
                  mode === 'long64'
                    ? prefix + 'ff1b'
                    : prefix + '9a' + 'ff'.repeat(operand / 8) + '3b00';
                const next = SOURCE + BigInt(code.length / 2);
                const oldSp = sameCpl ? 0x9003n : 0x4000n;
                await usingGate(
                  compiler,
                  {
                    family,
                    mode,
                    source32,
                    gateWidth: 64,
                    count: 255,
                    pointerWidth: operand,
                    code,
                    targetCpl: sameCpl ? 3 : 0,
                    newSp: 0x9003n,
                    prepare(memory, context) {
                      if (sameCpl) {
                        context.tr.valid = false;
                        if (family !== 'linear') memory.set(little(0x8067n, 8), 0x17040);
                      }
                    },
                  },
                  async (cpu) => {
                    if (mode === 'long64')
                      write(cpu, 0x5000n, little(0x800000000000n, operand / 8), family);
                    const before = initial(SOURCE, { 3: 0x5000n, 4: oldSp }, 0x402n);
                    cpu.setState(before);
                    const oldSS = cpu.readContext().segments.ss;
                    const enter = await cpu.run({ budget: 1n, repeatBudget: 0n });
                    complete(enter);
                    const final = sameCpl ? 0x8ff3n : 0x8fe3n;
                    equal(enter.state.registers[4], final, 'no 16-byte stack alignment');
                    equal(enter.state.rip, TARGET, 'embedded RIP only');
                    const expected = sameCpl ? [next, 0x1bn] : [next, 0x1bn, oldSp, 0x23n];
                    for (let i = 0; i < expected.length; i++)
                      equal(
                        scalar(cpu, final + BigInt(i * 8), 8, family),
                        expected[i],
                        `qword frame ${i}`,
                      );
                    if (sameCpl)
                      same(cpu.readContext().segments.ss, oldSS, 'same-CPL SS is untouched');
                    else {
                      equal(cpu.readContext().segments.ss.selector, 0, 'forced null SS index');
                      equal(
                        cpu.readContext().segments.ss.usable,
                        false,
                        'null SS loaded cache policy',
                      );
                      equal(cpu.readContext().segments.ss.dpl, 0, 'prospective CPL in null SS');
                      const checkpoint = cpu.readContext();
                      cpu.setContext(checkpoint);
                      same(cpu.readContext(), checkpoint, 'null SS context reimports exactly');
                    }
                    const leave = await cpu.run({ budget: 1n });
                    complete(leave);
                    equal(leave.state.rip, next, 'matching explicit RETF64');
                    equal(leave.state.registers[4], oldSp, 'full restored raw pointer');
                    equal(cpu.readContext().mode, mode, 'source submode restored');
                    equal(cpu.readContext().cpl, 3, 'caller CPL');
                    equal(leave.state.flags, 0x402n, 'no FLAGS slot or flag edits');
                  },
                );
              }
      },
    },
    {
      name: 'call gate64 same-CPL compatibility uses the complete dirty upper raw RSP and ignores old SS base and B',
      async run() {
        const high = 0x123400000000n;
        await usingGate(
          compiler,
          {
            mode: 'compatibility',
            source32: false,
            oldStack32: false,
            targetCpl: 3,
            gateWidth: 64,
            count: 255,
            prepare(_memory, context) {
              context.tr.valid = false;
              context.segments.ss.base = 0x300000n;
            },
          },
          async (cpu) => {
            cpu.setMappings([
              { base: 0n, backing: 'ram', offset: 0, length: RAM_SIZE, permissions: RWX },
              {
                base: high + 0x8000n,
                backing: 'ram',
                offset: 0xb000,
                length: 0x1003,
                permissions: RWX,
              },
            ]);
            const ss = cpu.readContext().segments.ss;
            cpu.setState(initial(SOURCE, { 4: high + 0x9003n }));
            const result = await cpu.run({ budget: 1n });
            complete(result);
            equal(
              result.state.registers[4],
              high + 0x8ff3n,
              'upper bank is part of qword stack address',
            );
            equal(
              scalar(cpu, high + 0x8ff3n, 8),
              0x1005n,
              'short compatibility instruction saves qword PC',
            );
            equal(scalar(cpu, high + 0x8ffbn, 8), 0x1bn, 'only caller CS');
            same(cpu.readContext().segments.ss, ss, 'all artificial old SS metadata retained');
          },
        );
      },
    },
    {
      name: 'call gate64 checks touched stack spans rather than initial RSP canonicality',
      async run() {
        for (const sameCpl of [false, true])
          for (const upper of [false, true]) {
            const pointer = upper ? 0xffff800000000000n : 0x800000000000n;
            await usingGate(
              compiler,
              { mode: 'long64', targetCpl: sameCpl ? 3 : 0, newSp: pointer },
              async (cpu) => {
                cpu.setMappings([
                  { base: 0n, backing: 'ram', offset: 0, length: RAM_SIZE, permissions: RWX },
                  {
                    base: 0x7ffffffff000n,
                    backing: 'ram',
                    offset: 0xb000,
                    length: 4096,
                    permissions: RWX,
                  },
                ]);
                cpu.setState(initial(SOURCE, { 3: 0x5000n, 4: sameCpl ? pointer : 0x4000n }));
                const result = await cpu.run({ budget: 1n });
                if (upper) {
                  equal(
                    result.reason,
                    'protection-fault',
                    'first subtraction touches canonical hole',
                  );
                  equal(result.protectionFault?.vector, 12, 'SS stack owner');
                  equal(
                    result.protectionFault?.errorCode,
                    0,
                    'null or unchanged 64-bit SS has code0',
                  );
                  equal(result.retired, 0n, 'no frame publication');
                } else {
                  complete(result);
                  equal(
                    result.state.registers[4],
                    pointer - (sameCpl ? 16n : 32n),
                    'every actual pushed span is canonical',
                  );
                }
              },
            );
          }
      },
    },
    {
      name: 'call gate64 extent precedes privilege while absent gates do not read high halves and reserved type bits remain selective',
      async run() {
        for (const kind of ['extent', 'absent', 'reserved', 'ignored', 'type4'] as const)
          await usingGate(
            compiler,
            {
              mode: 'long64',
              prepare(memory, context) {
                if (kind === 'extent') {
                  context.gdtr.limit = 0x3f;
                  memory[Number(GDT) + 0x3d] = 0x0c;
                } else if (kind === 'absent') {
                  memory[Number(GDT) + 0x3d] = 0x6c;
                  context.gdtr.base = 0x7fffffffffc0n;
                } else if (kind === 'reserved') memory[Number(GDT) + 0x45] = 1;
                else if (kind === 'ignored') {
                  memory[Number(GDT) + 0x3c] = 255;
                  memory[Number(GDT) + 0x44] = 255;
                  memory[Number(GDT) + 0x46] = 255;
                  memory[Number(GDT) + 0x47] = 255;
                } else memory.set(gateDescriptor(16), Number(GDT) + 0x38);
              },
            },
            async (cpu) => {
              if (kind === 'absent')
                cpu.setMappings([
                  { base: 0n, backing: 'ram', offset: 0, length: RAM_SIZE, permissions: RWX },
                  {
                    base: 0x7ffffffffff8n,
                    backing: 'ram',
                    offset: Number(GDT) + 0x38,
                    length: 8,
                    permissions: { read: true, write: false, execute: false },
                  },
                ]);
              cpu.setState(initial(SOURCE, { 3: 0x5000n, 4: 0x4000n }));
              const result = await cpu.run({ budget: 1n });
              if (kind === 'ignored') complete(result);
              else {
                equal(result.reason, 'protection-fault', kind);
                equal(
                  result.protectionFault?.vector,
                  kind === 'absent' ? 11 : 13,
                  'NP only after qualifying low privilege',
                );
                equal(result.protectionFault?.errorCode, 0x38, 'original gate reference');
                equal(result.systemMemoryFault, undefined, 'unselected high half not touched');
              }
            },
          );
      },
    },
  ];
}
