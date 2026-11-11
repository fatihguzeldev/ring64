import { equal, hex, physicalCpu, put, transitionProgram, type Scenario } from './fixture.js';

export function transitionScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'physical guest reset-style caches enter PE retain high CS then far load protected32',
      async run() {
        const ram = new Uint8Array(0x10000),
          rom = new Uint8Array(0x10000);
        rom.set(hex('e90df0'), 0xfff0);
        rom.set(hex('fa0f0116f0100f20c06683c8010f22c066ea002000000800'), 0xf000);
        ram.set(hex('170000100000'), 0x10f0);
        put(ram, 0x1008, 0x00cf9a000000ffffn);
        put(ram, 0x1010, 0x00cf92000000ffffn);
        ram.set(hex('66b810008ed88ec08ed0bc00400000'), 0x2000);
        const cpu = await physicalCpu(compiler, ram, rom);
        try {
          const near = await cpu.run({ budget: 1n });
          equal(near.state.rip, 0xf000n, 'near keeps high reset base');
          const pe = await cpu.run({ budget: 5n });
          equal(pe.reason, 'budget', 'PE writer completes');
          equal(cpu.readPagingState().cr0, 0x60000011n, 'PE enabled');
          const transitional = cpu.readContext();
          equal(transitional.mode, 'protected', 'derived protected mode');
          equal(transitional.segments.cs.base, 0xffff0000n, 'retained reset base');
          equal(transitional.segments.cs.type, 'read-write', 'retained reset CS type');
          cpu.setContext(transitional);
          const far = await cpu.run({ budget: 1n });
          equal(far.state.rip, 0x2000n, 'far target');
          equal(cpu.readContext().segments.cs.default32, true, 'loaded CS.D32');
          equal(cpu.readPhysicalMemory(0x100dn, 1)[0], 0x9b, 'descriptor A');
          const stack = await cpu.run({ budget: 5n });
          equal(stack.state.registers[4], 0x4000n, 'ESP initialized');
          equal(cpu.readContext().segments.ss.default32, true, 'loaded SS.B32');
        } finally {
          cpu.dispose();
        }
      },
    },
    {
      name: 'one physical CPU executes the complete 69 instruction real legacy PAE IA32e return story',
      async run() {
        const { ram, rom } = transitionProgram(),
          cpu = await physicalCpu(compiler, ram, rom);
        try {
          const result = await cpu.run({ budget: 100n, stop: 0x403n });
          equal(result.reason, 'stop', 'final real target');
          equal(result.retired, 69n, 'exact guest retirement');
          equal(result.remaining, 31n, 'bounded completion');
          const bank = cpu.readPagingState();
          equal(bank.cr0, 0x32n, 'PE PG cleared');
          equal(bank.cr4, 0x608n, 'PAE cleared');
          equal(bank.efer, 0n, 'LME LMA cleared');
          equal(bank.cr3, 0x3b000n, 'root retained');
          const context = cpu.readContext();
          equal(context.mode, 'real', 'returned real');
          equal(context.segments.cs.base, 0x10000n, 'real far base');
          equal(context.segments.cs.default32, false, 'explicit CS16');
          equal(context.segments.ss.default32, true, 'unreal SS retained');
          equal(result.state.registers[0]! & 0xffffn, 0xbeefn, 'final AX');
          for (const [address, value] of [
            [0x90000n, 0x11111111],
            [0x91000n, 0x22222222],
            [0x92000n, 0x33333333],
            [0x92004n, 0x44444444],
            [0x6000n, 0x55555555],
          ] as const) {
            const bytes = cpu.readPhysicalMemory(address, 4);
            equal(
              new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true),
              value,
              'translated physical witness',
            );
          }
        } finally {
          cpu.dispose();
        }
      },
    },
  ];
}
