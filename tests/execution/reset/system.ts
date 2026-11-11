import { equal, hex, physicalCpu, put, resetContext, type Scenario } from './fixture.js';
export function systemScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'PG0 real INT IRET stack and IDT traffic use physical identity with untouched table-looking RAM',
      async run() {
        const context = resetContext();
        context.segments.cs.selector = 0;
        context.segments.cs.base = 0n;
        const ram = new Uint8Array(0x10000);
        ram.set(hex('cd0390'), 0x1000);
        ram[0x300] = 0xcf;
        put(ram, 12, 0x300n, 4);
        ram.fill(0xa5, 0x3000, 0x3040);
        const cpu = await physicalCpu(
          compiler,
          ram,
          new Uint8Array(0x10000),
          { cr0: 0x32n, cr2: 0xfedcba9876543210n, cr3: 0x3000n, cr4: 0x20n, efer: 0x100n },
          context,
        );
        try {
          const registers = Array<bigint>(16).fill(0n);
          registers[4] = 0x8000n;
          cpu.setState({ registers, flags: 0x202n, rip: 0x1000n });
          const entered = await cpu.run({ budget: 1n });
          equal(entered.retired, 1n, 'INT retirement');
          equal(entered.state.rip, 0x300n, 'real IDT target');
          equal(entered.state.registers[4], 0x7ffan, 'three-word frame');
          equal(
            Array.from(cpu.readPhysicalMemory(0x7ffan, 6)).join(','),
            '2,16,0,0,2,2',
            'independent real frame bytes',
          );
          const returned = await cpu.run({ budget: 1n });
          equal(returned.retired, 1n, 'IRET retirement');
          equal(returned.state.rip, 0x1002n, 'real resumed IP');
          equal(returned.state.registers[4], 0x8000n, 'stack restored');
          equal(returned.state.flags, 0x202n, 'flags restored');
          equal(
            cpu.readPhysicalMemory(0x3000n, 64).every((b) => b === 0xa5),
            true,
            'zero walk A D or quartet work',
          );
          equal(cpu.readPagingState().pdpte, undefined, 'PAE armed is not latched');
          equal(cpu.readPagingState().cr2, 0xfedcba9876543210n, 'CR2 untouched');
        } finally {
          cpu.dispose();
        }
      },
    },
    {
      name: 'PG0 prepared RMW and FX image operations use identity and preserve nonzero control roots',
      async run() {
        const context = resetContext();
        context.segments.cs = {
          ...context.segments.cs,
          selector: 0,
          base: 0n,
          default32: true,
          limit: 0xffffffff,
        };
        const ram = new Uint8Array(0x10000);
        ram.set(hex('0fc105006000000fae05006100000fae0d00610000'), 0x1000);
        put(ram, 0x6000, 5n, 4);
        ram.fill(0xa5, 0x3000, 0x3040);
        const cpu = await physicalCpu(
          compiler,
          ram,
          new Uint8Array(0x10000),
          { cr0: 0x32n, cr2: 0xdeadn, cr3: 0x3000n, cr4: 0x600n, efer: 0n },
          context,
        );
        try {
          const registers = Array<bigint>(16).fill(0n);
          registers[0] = 7n;
          cpu.setState({ registers, flags: 2n, rip: 0x1000n });
          const xmm = Array<bigint>(16).fill(0n);
          xmm[0] = 0x123456789abcdef00123456789abcdefn;
          cpu.setXmmState(xmm);
          const result = await cpu.run({ budget: 3n });
          equal(result.retired, 3n, 'RMW FX save restore');
          equal(result.state.registers[0], 5n, 'XADD old memory');
          equal(cpu.readPhysicalMemory(0x6000n, 1)[0], 12, 'XADD store');
          equal(cpu.readXmmState()[0], xmm[0], 'FX restored XMM');
          equal(
            cpu.readPhysicalMemory(0x3000n, 64).every((b) => b === 0xa5),
            true,
            'no fake dirty leaf',
          );
          equal(cpu.readPagingState().cr2, 0xdeadn, 'no PF metadata');
        } finally {
          cpu.dispose();
        }
      },
    },
    {
      name: 'a completed PE clear selects single-step after committing the real destination envelope',
      async run() {
        const context = resetContext();
        context.mode = 'protected';
        context.segments.cs = {
          ...context.segments.cs,
          selector: 8,
          base: 0n,
          default32: true,
          limit: 0xffffffff,
          type: 'readable-code',
        };
        const ram = new Uint8Array(0x10000);
        ram.set(hex('0f22c0'), 0x1000);
        const cpu = await physicalCpu(
          compiler,
          ram,
          new Uint8Array(0x10000),
          { cr0: 0x33n, cr2: 0n, cr3: 0n, cr4: 0n, efer: 0n },
          context,
        );
        try {
          const registers = Array<bigint>(16).fill(0n);
          registers[0] = 0x32n;
          cpu.setState({ registers, flags: 0x102n, rip: 0x1000n });
          const result = await cpu.run({ budget: 1n });
          equal(result.reason, 'debug-exception', 'completion TF wins budget');
          equal(result.retired, 1n, 'writer retired once');
          equal(result.debugException?.instructionPc, 0x1000n, 'writer source');
          equal(result.debugException?.resumePc, 0x1003n, 'committed target');
          equal(result.debugException?.instructionCompleted, true, 'completed trap');
          equal(cpu.readContext().mode, 'real', 'destination already published');
          equal(cpu.readPagingState().cr0, 0x32n, 'PE clear committed');
          equal(cpu.readContext().segments.cs.default32, true, 'unreal CS.D retained');
        } finally {
          cpu.dispose();
        }
      },
    },
    {
      name: 'historic high-canonical PF source and raw CR2 remain independent of a PG0 restore family',
      async run() {
        const context = resetContext();
        context.segments.cs.selector = 0;
        context.segments.cs.base = 0n;
        const cpu = await physicalCpu(
          compiler,
          new Uint8Array(0x10000),
          new Uint8Array(0x10000),
          { cr0: 0x32n, cr2: 0x1111222233334444n, cr3: 0n, cr4: 0n, efer: 0n },
          context,
        );
        try {
          cpu.setState({
            registers: Array<bigint>(16).fill(0n),
            flags: 2n,
            rip: 0x1000n,
            event: {
              kind: 'pending',
              exception: {
                vector: 14,
                instructionPc: 0x1000n,
                returnPc: 0x1000n,
                savedFlags: 0x10002n,
                errorCode: 0x11,
                pageFaultAddress: 0xffff800000001234n,
              },
            },
          });
          const source = cpu.readState().event;
          equal(source.kind, 'pending', 'historical event imported');
          if (source.kind === 'pending')
            equal(source.exception.pageFaultAddress, 0xffff800000001234n, 'frozen high PF source');
          cpu.setPagingState({ ...cpu.readPagingState(), cr2: 0x99n });
          const result = await cpu.run({ budget: 1n });
          equal(result.reason, 'pending-exception', 'historical event is not reclassified');
          equal(cpu.readPagingState().cr2, 0x99n, 'live repair independent');
          cpu.reset();
          equal(cpu.readState().event.kind, 'ready', 'reset clears historic source');
        } finally {
          cpu.dispose();
        }
      },
    },
  ];
}
