import { equal, hex, physicalCpu, resetContext, type Scenario } from './fixture.js';
function real32() {
  const context = resetContext();
  context.segments.cs = {
    ...context.segments.cs,
    selector: 0,
    base: 0n,
    default32: true,
    limit: 0xffffffff,
  };
  return context;
}
export function controlScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'physical NE0 waiting families preserve RF and operands while enable gates still win',
      async run() {
        const forms = [
          'd9d0',
          '9b',
          '0f77',
          '0f6fc0',
          '0fe70500600000',
          '0ff7c0',
          '0f2ac0',
          '0f2dc0',
          'd92500600000',
          'dd2500600000',
        ];
        for (const bytes of forms) {
          const ram = new Uint8Array(0x10000);
          ram.set(hex(bytes), 0x1000);
          const cpu = await physicalCpu(
            compiler,
            ram,
            new Uint8Array(0x10000),
            { cr0: 0x12n, cr2: 0xdeadn, cr3: 0n, cr4: 0x600n, efer: 0n },
            real32(),
          );
          try {
            cpu.setState({ registers: Array<bigint>(16).fill(0n), flags: 0x10002n, rip: 0x1000n });
            const x87 = {
              ...cpu.readX87State(),
              controlWord: 0x37e,
              statusWord: 0x8081,
              instructionPointer: 0x777n,
              dataPointer: 0x666n,
              opcode: 0x123,
            };
            cpu.setX87State(x87);
            const result = await cpu.run({ budget: 1n });
            equal(result.reason, 'unsupported', 'NE0 ' + bytes);
            equal(result.retired, 0n, 'not retired ' + bytes);
            equal(result.state.flags, 0x10002n, 'RF before pending ' + bytes);
            equal(result.x87Exception, undefined, 'no MF ' + bytes);
            equal(result.state.event.kind, 'ready', 'no event ' + bytes);
            equal(cpu.readPagingState().cr2, 0xdeadn, 'no operand PF ' + bytes);
            equal(cpu.readX87State().statusWord, 0x8081, 'old condition ' + bytes);
            cpu.setPagingState({ ...cpu.readPagingState(), cr0: 0x1an });
            const nm = await cpu.run({ budget: 1n });
            equal(nm.reason, 'device-not-available', 'TS before NE ' + bytes);
            cpu.setPagingState({ ...cpu.readPagingState(), cr0: 0x32n });
            const mf = await cpu.run({ budget: 1n });
            equal(mf.reason, 'x87-exception', 'NE1 MF ' + bytes);
            equal(mf.x87Exception?.instructionPointer, 0x777n, 'original producer ' + bytes);
          } finally {
            cpu.dispose();
          }
        }
      },
    },
    {
      name: 'physical DE aliases DR4 DR5 and illegal DE1 precedes privilege and GD',
      async run() {
        for (const de of [false, true])
          for (const gd of [false, true])
            for (const register of [4, 5]) {
              const ram = new Uint8Array(0x10000);
              ram.set([0x0f, 0x21, 0xc0 | (register << 3)], 0x1000);
              const cpu = await physicalCpu(
                compiler,
                ram,
                new Uint8Array(0x10000),
                { cr0: 0x32n, cr2: 0n, cr3: 0n, cr4: de ? 8n : 0n, efer: 0n },
                real32(),
              );
              try {
                cpu.setState({
                  registers: Array<bigint>(16).fill(0xaaaa000000000000n),
                  flags: 0x10002n,
                  rip: 0x1000n,
                });
                cpu.setDebugState({
                  addresses: [0n, 0n, 0n, 0n],
                  dr6: 0xffff4ff5n,
                  dr7: gd ? 0x2400n : 0x400n,
                });
                const before = cpu.readDebugState();
                const result = await cpu.run({ budget: 1n });
                if (de) {
                  equal(result.reason, 'invalid-encoding', 'DE UD');
                  equal(result.retired, 0n, 'illegal DR no retirement');
                  equal(cpu.readDebugState().dr6, before.dr6, 'no BD');
                  equal(cpu.readDebugState().dr7, before.dr7, 'GD untouched');
                  equal(result.state.flags, 0x10002n, 'early UD RF');
                } else if (gd) {
                  equal(result.reason, 'debug-exception', 'alias GD');
                  equal(result.debugException?.cause, 'general-detect', 'GD selection');
                  equal(cpu.readDebugState().dr6 & 0x2000n, 0x2000n, 'BD');
                } else {
                  equal(result.reason, 'budget', 'alias read');
                  equal(
                    result.state.registers[0],
                    0xaaaa000000000000n | (register === 4 ? before.dr6 : before.dr7),
                    'nonlong alias preserves parent',
                  );
                }
              } finally {
                cpu.dispose();
              }
            }
        const ram = new Uint8Array(0x10000);
        ram.set(hex('0f23e00f23e80f21e10f21e9'), 0x1000);
        const cpu = await physicalCpu(
          compiler,
          ram,
          new Uint8Array(0x10000),
          { cr0: 0x32n, cr2: 0n, cr3: 0n, cr4: 0n, efer: 0n },
          real32(),
        );
        try {
          cpu.setState({
            registers: [0x400n, ...Array<bigint>(15).fill(0n)],
            flags: 2n,
            rip: 0x1000n,
          });
          const result = await cpu.run({ budget: 4n });
          equal(result.retired, 4n, 'alias writes/readbacks');
          equal(result.state.registers[1], 0x400n, 'DR5 readback');
          equal(cpu.readDebugState().dr7, 0x400n, 'DR5 write target');
        } finally {
          cpu.dispose();
        }
      },
    },
    {
      name: 'physical selected MSRs work in PG0 without widening fast instruction semantics',
      async run() {
        const ram = new Uint8Array(0x10000);
        ram.set(hex('0f300f320f34'), 0x1000);
        const cpu = await physicalCpu(
          compiler,
          ram,
          new Uint8Array(0x10000),
          { cr0: 0x32n, cr2: 0n, cr3: 0n, cr4: 0n, efer: 0n },
          real32(),
        );
        try {
          const regs = Array<bigint>(16).fill(0n);
          regs[0] = 0xaaaa000000001234n;
          regs[1] = 0x174n;
          regs[2] = 0x1111000000000000n;
          cpu.setState({ registers: regs, flags: 2n, rip: 0x1000n });
          const result = await cpu.run({ budget: 2n });
          equal(result.retired, 2n, 'legacy MSR pair');
          equal(cpu.readFastSystemState().sysenterCs, 0x1234n, 'live selected bank');
          equal(result.state.registers[0], 0x1234n, 'RDMSR zeroextends EAX');
          equal(result.state.registers[2], 0n, 'RDMSR zeroextends EDX');
          const fast = await cpu.run({ budget: 1n });
          equal(fast.reason, 'unsupported', 'legacy SYSENTER frontier');
          equal(fast.retired, 0n, 'frontier no side effect');
        } finally {
          cpu.dispose();
        }
      },
    },
  ];
}
