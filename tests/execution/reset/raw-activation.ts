import { equal, hex, physicalCpu, put, resetContext, type Scenario } from './fixture.js';
export function rawActivationScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'legal IA32e activation preserves noncanonical raw physical full caches through read set and restore until actual use',
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
        context.segments.fs.base = 0x800000000000n;
        context.segments.gs.base = 0xffff7fff00000000n;
        context.gdtr.base = 0x800000000001n;
        context.idtr.base = 0x800000000002n;
        context.ldtr.base = 0x800000000003n;
        context.tr.base = 0x800000000004n;
        const ram = new Uint8Array(0x10000),
          rom = new Uint8Array(0x10000);
        ram.set(hex('0f22c064488b0500000000'), 0x1000);
        put(ram, 0x3000, 0x4003n);
        put(ram, 0x4000, 0x5003n);
        put(ram, 0x5000, 0x6003n);
        put(ram, 0x6008, 0x1003n);
        const cpu = await physicalCpu(
          compiler,
          ram,
          rom,
          { cr0: 0x33n, cr2: 0xdeadn, cr3: 0x3000n, cr4: 0x620n, efer: 0x100n },
          context,
        );
        let restored: Awaited<ReturnType<typeof physicalCpu>> | undefined;
        let long: Awaited<ReturnType<typeof physicalCpu>> | undefined;
        try {
          const registers = Array<bigint>(16).fill(0n);
          registers[0] = 0x80000033n;
          cpu.setState({ registers, flags: 2n, rip: 0x1000n });
          const activation = await cpu.run({ budget: 1n });
          equal(activation.retired, 1n, 'legal PG activation');
          equal(cpu.readPagingState().efer, 0x500n, 'LMA committed');
          const snapshot = cpu.readContext();
          equal(snapshot.mode, 'compatibility', 'derived compatibility');
          const check = (actual: typeof snapshot) => {
            equal(actual.segments.fs.base, context.segments.fs.base, 'raw FS');
            equal(actual.segments.gs.base, context.segments.gs.base, 'raw GS');
            equal(actual.gdtr.base, context.gdtr.base, 'raw GDTR');
            equal(actual.idtr.base, context.idtr.base, 'raw IDTR');
            equal(actual.ldtr.base, context.ldtr.base, 'raw LDTR');
            equal(actual.tr.base, context.tr.base, 'raw TR');
          };
          check(snapshot);
          cpu.setContext(snapshot);
          check(cpu.readContext());
          restored = await physicalCpu(compiler, ram, rom, cpu.readPagingState(), snapshot);
          check(restored.readContext());
          restored.setState(cpu.readState());
          const wide = {
            ...snapshot,
            mode: 'long64' as const,
            segments: {
              ...snapshot.segments,
              cs: { ...snapshot.segments.cs, default32: false, long: true },
            },
          };
          long = await physicalCpu(compiler, ram, rom, cpu.readPagingState(), wide);
          long.setState(cpu.readState());
          check(long.readContext());
          long.setContext(long.readContext());
          const use = await long.run({ budget: 1n });
          equal(use.reason, 'data-fault', 'canonicality checked at FS operand use');
          equal(use.fault?.cause, 'noncanonical', 'raw base not truncated');
          equal(use.retired, 0n, 'no operand publication');
          check(long.readContext());
          equal(long.readPagingState().cr2, 0xdeadn, 'segment-level refusal is not PF');
        } finally {
          cpu.dispose();
          restored?.dispose();
          long?.dispose();
        }
      },
    },
  ];
}
