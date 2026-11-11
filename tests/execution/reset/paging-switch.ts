import { equal, hex, physicalCpu, put, resetContext, type Scenario } from './fixture.js';
function context32() {
  const c = resetContext();
  c.mode = 'protected';
  c.segments.cs = {
    ...c.segments.cs,
    selector: 8,
    base: 0n,
    default32: true,
    limit: 0xffffffff,
    type: 'readable-code',
  };
  return c;
}
function switchBytes(alias = false) {
  const ram = new Uint8Array(0xa0000);
  ram.set(hex('c70500600000111111110f22e0c7050060000022222222'), 0x20000);
  put(ram, 0x31000, 0x32003n, 4);
  put(ram, 0x32018, 0x90003n, 4);
  put(ram, 0x32080, 0x20003n, 4);
  put(ram, alias ? 0x31000 : 0x31020, 0x33001n);
  put(ram, 0x33000, 0x34003n);
  put(ram, 0x34030, 0x91003n);
  put(ram, 0x34100, 0x20003n);
  return ram;
}
export function pagingSwitchScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'direct PG1 PAE switch captures a disjoint quartet and both old and new mappings consume operands',
      async run() {
        const ram = switchBytes(),
          cpu = await physicalCpu(
            compiler,
            ram,
            new Uint8Array(0x10000),
            { cr0: 0x80000033n, cr2: 0xdeadn, cr3: 0x31020n, cr4: 0x608n, efer: 0n },
            context32(),
          );
        try {
          const registers = Array<bigint>(16).fill(0n);
          registers[0] = 0x628n;
          cpu.setState({ registers, flags: 2n, rip: 0x20000n });
          const result = await cpu.run({ budget: 3n });
          equal(result.retired, 3n, 'write switch write');
          equal(result.reason, 'budget', 'PAE successor');
          equal(cpu.readPagingState().pdpte?.[0], 0x33001n, 'captured PDPT raw');
          equal(cpu.readPhysicalMemory(0x90000n, 1)[0], 0x11, 'non-PAE witness');
          equal(cpu.readPhysicalMemory(0x91000n, 1)[0], 0x22, 'PAE witness');
          // Re-execute only the control form with the non-PAE value. The effective
          // low-32 root and its raw 0x20 field survive the round trip.
          cpu.setState({
            ...cpu.readState(),
            registers: [0x608n, ...registers.slice(1)],
            rip: 0x2000an,
          });
          const back = await cpu.run({ budget: 1n });
          equal(back.retired, 1n, 'PAE clear');
          equal(cpu.readPagingState().pdpte, undefined, 'quartet discarded');
          equal(cpu.readPagingState().cr3, 0x31020n, 'raw root retained');
        } finally {
          cpu.dispose();
        }
      },
    },
    {
      name: 'a source PDE accessed write can make an aliased destination PDPTE reserved before atomic PAE activation',
      async run() {
        const ram = new Uint8Array(0x50000);
        ram.set(hex('0f22e0'), 0x20000);
        put(ram, 0x31000, 0x32003n, 4);
        put(ram, 0x32080, 0x20003n, 4);
        const cpu = await physicalCpu(
          compiler,
          ram,
          new Uint8Array(0x10000),
          { cr0: 0x80000033n, cr2: 0xdeadn, cr3: 0x31000n, cr4: 0x608n, efer: 0n },
          context32(),
        );
        try {
          const registers = Array<bigint>(16).fill(0n);
          registers[0] = 0x628n;
          cpu.setState({ registers, flags: 2n, rip: 0x20000n });
          const result = await cpu.run({ budget: 1n });
          equal(result.reason, 'protection-fault', 'reserved aliased PDPTE');
          equal(result.protectionFault?.vector, 13, 'writer GP');
          equal(result.retired, 0n, 'uncommitted writer');
          equal(cpu.readPagingState().cr4, 0x608n, 'old non-PAE state');
          equal(cpu.readPagingState().pdpte, undefined, 'no partial quartet');
          equal(cpu.readPhysicalMemory(0x31000n, 1)[0], 0x23, 'required source A survived');
          equal(cpu.readPagingState().cr2, 0xdeadn, 'writer GP does not set CR2');
        } finally {
          cpu.dispose();
        }
      },
    },
    {
      name: 'cold resource probe does not execute illegal control writers or consume an inaccessible PDPT',
      async run() {
        const ram = new Uint8Array(0x10000);
        ram.set(hex('900f22e0'), 0x1000);
        const cpu = await physicalCpu(
          compiler,
          ram,
          new Uint8Array(0x10000),
          { cr0: 0x80000033n, cr2: 0n, cr3: 0x3000n, cr4: 0x608n, efer: 0n },
          context32(),
          { limits: { maxInstructions: 1, maxTranslationsPerRun: 1 } },
        );
        // Build a valid source walk with inaccessible proposed root retained only as
        // an operand to a future MOV CR3, so no speculative control interpreter runs.
        try {
          cpu.writePhysicalMemory(0x3000n, hex('03400000'));
          cpu.writePhysicalMemory(0x4004n, hex('03100000'));
          const registers = Array<bigint>(16).fill(0n);
          registers[0] = 0x628n;
          cpu.setState({ registers, flags: 2n, rip: 0x1000n });
          const result = await cpu.run({ budget: 2n });
          equal(result.reason, 'resource-limit', 'cold writer quota');
          equal(result.retired, 1n, 'only NOP executed');
          equal(result.state.rip, 0x1001n, 'writer unexecuted');
          equal(cpu.readPagingState().cr4, 0x608n, 'no PAE publication');
          equal(cpu.readPagingState().pdpte, undefined, 'no speculative quartet');
        } finally {
          cpu.dispose();
        }
      },
    },
  ];
}
