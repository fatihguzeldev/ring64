import { createCpu } from '../../../host/index.js';
import { equal, check, LIMITS, initial, type Scenario } from '../../support/fixture.js';
import { resetContext } from '../reset/fixture.js';

export function ioResetScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'physical reset retains the captured port receiver and external queue without device hooks',
      async run() {
        const ram = new Uint8Array(0x2000);
        ram[0x1000] = 0xec;
        const rom = new Uint8Array(0x10000);
        rom[0xfff0] = 0xec;
        const context = resetContext();
        context.segments.cs.selector = 0;
        context.segments.cs.base = 0n;
        const ports: number[] = [];
        let hookReads = 0,
          runningResetRejected = 0;
        const provider = {
          queue: [0x11, 0x22],
          read(port: number) {
            ports.push(port);
            if (ports.length === 2) {
              try {
                cpu.reset();
              } catch {
                runningResetRejected++;
              }
            }
            return this.queue.shift()!;
          },
          write() {},
          get reset() {
            hookReads++;
            throw new Error('device reset hook must not be read');
          },
          get dispose() {
            hookReads++;
            throw new Error('device dispose hook must not be read');
          },
        };
        const cpu = await createCpu({
          compiler,
          limits: LIMITS,
          memoryModel: 'physical',
          context,
          paging: { cr0: 0x10n, cr2: 0n, cr3: 0n, cr4: 0n, efer: 0n },
          entry: 0x1000n,
          io: provider,
          memoryLimits: {
            maxBackingBytes: ram.length + rom.length,
            maxBackings: 2,
            maxMappings: 2,
          },
          memory: {
            backings: [
              { id: 'ram', bytes: ram },
              { id: 'rom', bytes: rom },
            ],
            mappings: [
              {
                base: 0n,
                backing: 'ram',
                offset: 0,
                length: ram.length,
                permissions: { read: true, write: true, execute: true },
              },
              {
                base: 0xffff0000n,
                backing: 'rom',
                offset: 0,
                length: rom.length,
                permissions: { read: true, write: false, execute: true },
              },
            ],
          },
        });
        try {
          cpu.setState(initial(0x1000n, { 0: 0n, 2: 0x80n }));
          const first = await cpu.run({ budget: 1n });
          equal(first.reason, 'budget', 'unpaged real I/O');
          equal(first.state.registers[0], 0x11n, 'first input');
          provider.read = () => {
            throw new Error('captured method replacement must not run');
          };
          let staleCaptureRejected = false;
          try {
            await cpu.run({
              get budget() {
                cpu.reset();
                return 1n;
              },
            });
          } catch {
            staleCaptureRejected = true;
          }
          check(staleCaptureRejected, 'reset during run-option capture rejects stale outer call');
          equal(ports.length, 1, 'reset/capture calls no provider');
          equal(provider.queue.join(','), '34', 'external queue not rewound');
          const reset = cpu.readState();
          equal(reset.rip, 0xfff0n, 'native reset persists after stale capture');
          equal(reset.registers[2], 0x600n, 'literal reset EDX');
          const second = await cpu.run({ budget: 1n });
          equal(second.reason, 'budget', 'reset-vector I/O uses same binding');
          equal(second.state.rip, 0xfff1n, 'real reset CS fetch');
          equal(second.state.registers[0], 0x22n, 'fresh second input');
          equal(ports.join(','), '128,1536', 'live DX before and after reset');
          equal(runningResetRejected, 1, 'reset rejects running callback');
          equal(provider.queue.length, 0, 'external input history retained');
          equal(hookReads, 0, 'no device hooks');
          equal(
            cpu.readX87State().controlWord,
            0x40,
            'I/O does not perform numeric initialization',
          );
          equal(cpu.readPhysicalMemory(0x1000n, 1)[0], 0xec, 'RAM source preserved');
          equal(cpu.readPhysicalMemory(0xfffffff0n, 1)[0], 0xec, 'ROM source preserved');
        } finally {
          cpu.dispose();
        }
        equal(hookReads, 0, 'CPU disposal invokes no device hook');
      },
    },
  ];
}
