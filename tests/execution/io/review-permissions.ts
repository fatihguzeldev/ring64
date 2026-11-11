import { createCpu } from '../../../host/index.js';
import { LIMITS, check, equal, hex, initial, type Scenario } from '../../support/fixture.js';
import { snapshot } from '../far-control/fixture.js';

export function ioPermissionReviewScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'port imported TSS geometry distinguishes noncanonical GP from widened private domain overflow',
      async run() {
        for (const [base, address, failing] of [
          [0x800000000000n, undefined, undefined],
          [0xffffffffffffff99n, 0xffffffffffffffffn, 1n << 64n],
          [0xffffffffffffffa0n, (1n << 64n) + 6n, (1n << 64n) + 6n],
        ] as const) {
          const context = snapshot('long64', 3);
          context.tr = { selector: 0x28, valid: true, base, limit: 0x2080, attributes: 0x8b };
          let calls = 0;
          const cpu = await createCpu({
            compiler,
            limits: LIMITS,
            context,
            code: { base: 0x1000n, bytes: hex('ec') },
            ram: { base: 0x4000n, bytes: new Uint8Array(1) },
            io: {
              read() {
                calls++;
                return 0x6b;
              },
              write() {},
            },
          });
          try {
            cpu.setState(initial(0x1000n));
            const result = await cpu.run({ budget: 1n });
            equal(result.retired, 0n, 'no permission-failed instruction');
            equal(calls, 0, 'no input before valid TSS geometry');
            if (address === undefined) {
              equal(result.reason, 'protection-fault', 'noncanonical permission field');
              equal(result.protectionFault?.vector, 13, 'selected GP not event TS');
              equal(result.protectionFault?.errorCode, 0, 'hard-zero error');
              equal(result.protectionFault?.selector, undefined, 'no faulting-selector invention');
            } else {
              equal(result.reason, 'system-memory-fault', 'private widened domain');
              equal(result.systemMemoryFault?.address, address, 'widened start preserved');
              equal(result.systemMemoryFault?.failingAddress, failing, 'widened failing address');
              equal(result.systemMemoryFault?.width, 2, 'u16 map-base field');
              const fault = result.systemMemoryFault;
              check(fault?.table === 'tss', 'implicit provenance');
              equal(fault.selector, 0x28, 'loaded TR selector');
            }
          } finally {
            cpu.dispose();
          }
        }
      },
    },
    {
      name: 'port terminal masks bounds and short maps retain mandatory two-byte permission admission',
      async run() {
        const cases = [
          {
            port: 0xffff,
            width: 8,
            limit: 0x2080,
            length: 0x2081,
            terminal: 0xff,
            reason: 'budget',
            calls: 1,
          },
          {
            port: 0xffff,
            width: 16,
            limit: 0x2080,
            length: 0x2081,
            terminal: 0xff,
            reason: 'protection-fault',
            calls: 0,
          },
          {
            port: 0xfffd,
            width: 32,
            limit: 0x2080,
            length: 0x2081,
            terminal: 0xff,
            reason: 'protection-fault',
            calls: 0,
          },
          {
            port: 0xffff,
            width: 16,
            limit: 0x2080,
            length: 0x2081,
            terminal: 0,
            reason: 'unsupported',
            calls: 0,
          },
          {
            port: 0xffff,
            width: 8,
            limit: 0x207f,
            length: 0x2080,
            terminal: 0,
            reason: 'protection-fault',
            calls: 0,
          },
          {
            port: 0xffff,
            width: 8,
            limit: 0x2080,
            length: 0x2080,
            terminal: 0,
            deny: true,
            reason: 'system-memory-fault',
            calls: 0,
          },
        ] as const;
        for (const packet of cases) {
          const context = snapshot('long64', 3);
          context.tr = {
            selector: 0x28,
            valid: true,
            base: 0x8000n,
            limit: packet.limit,
            attributes: 0x8b,
          };
          const tss = new Uint8Array(packet.length);
          tss[0x66] = 0x80;
          if (packet.length > 0x2080) tss[0x2080] = packet.terminal;
          if ('deny' in packet) tss[0x207f] = 0xff;
          let calls = 0;
          const cpu = await createCpu({
            compiler,
            limits: LIMITS,
            context,
            code: {
              base: 0x1000n,
              bytes: hex(packet.width === 8 ? 'ec' : packet.width === 16 ? '66ed' : 'ed'),
            },
            ram: { base: 0x8000n, bytes: tss },
            io: {
              read(port, width) {
                equal(port, packet.port, 'full high port');
                equal(width, packet.width, 'full requested width');
                calls++;
                return 0x7b;
              },
              write() {
                throw Error('no output');
              },
            },
          });
          try {
            cpu.setState(initial(0x1000n, { 2: BigInt(packet.port) }));
            const result = await cpu.run({ budget: 1n });
            equal(result.reason, packet.reason, 'terminal permission decision');
            equal(calls, packet.calls, 'permission before effect');
            if (packet.reason === 'protection-fault') {
              equal(result.protectionFault?.vector, 13, 'GP not TS');
              equal(result.protectionFault?.errorCode, 0, 'hard-zero error');
              equal(result.protectionFault?.selector, undefined, 'no invented fault selector');
            }
            if (packet.reason === 'system-memory-fault') {
              equal(result.systemMemoryFault?.address, 0xa07fn, 'whole permission word');
              equal(result.systemMemoryFault?.width, 2, 'mandatory word width');
              equal(
                result.systemMemoryFault?.failingAddress,
                0xa080n,
                'terminal missing byte beats first-byte denial',
              );
              equal(result.systemMemoryFault?.table, 'tss', 'implicit TSS provenance');
              equal(result.systemMemoryFault?.phase, 'tss-read', 'implicit phase');
            }
          } finally {
            cpu.dispose();
          }
        }
        for (const [base, limit] of [
          [0x67, 0x68],
          [0xf000, 0xf001],
        ] as const) {
          const context = snapshot('protected', 3);
          context.tr = { selector: 0x28, valid: true, base: 0x8000n, limit, attributes: 0x8b };
          const ram = new Uint8Array(limit + 1);
          new DataView(ram.buffer).setUint16(0x66, base, true);
          let calls = 0;
          const cpu = await createCpu({
            compiler,
            limits: LIMITS,
            context,
            code: { base: 0x1000n, bytes: hex('ec') },
            ram: { base: 0x8000n, bytes: ram },
            io: {
              read() {
                calls++;
                return 0x6b;
              },
              write() {},
            },
          });
          try {
            cpu.setState(initial(0x1000n));
            const result = await cpu.run({ budget: 1n });
            equal(result.reason, 'budget', 'short/nontraditional map remains admissible');
            equal(calls, 1, 'one byte request');
            equal(result.state.registers[0]! & 255n, 0x6bn, 'returned AL value');
          } finally {
            cpu.dispose();
          }
        }
      },
    },
    {
      name: 'port bypass cannot inspect malformed TR and implicit bitmap reads never become data watchpoints',
      async run() {
        for (const width of [8, 16, 32]) {
          let calls = 0;
          const cpu = await createCpu({
            compiler,
            limits: LIMITS,
            code: { base: 0x1000n, bytes: hex(width === 8 ? 'ec' : width === 16 ? '66ed' : 'ed') },
            ram: { base: 0x4000n, bytes: new Uint8Array(1) },
            io: {
              read() {
                calls++;
                return 0x7b;
              },
              write() {},
            },
          });
          try {
            cpu.setState(initial(0x1000n, { 2: 0xffffn }));
            const result = await cpu.run({ budget: 1n });
            equal(
              result.reason,
              width === 8 ? 'budget' : 'unsupported',
              'bypass beyond-space frontier',
            );
            equal(calls, width === 8 ? 1 : 0, 'one full-width effect or none');
            check(!result.systemMemoryFault, 'bypass never probes absent TSS');
          } finally {
            cpu.dispose();
          }
        }
        const context = snapshot('protected', 3);
        context.tr = { selector: 0x28, valid: true, base: 0x8000n, limit: 0x81, attributes: 0x8b };
        const ram = new Uint8Array(0x82);
        ram[0x66] = 0x80;
        let calls = 0;
        const cpu = await createCpu({
          compiler,
          limits: LIMITS,
          context,
          code: { base: 0x1000n, bytes: hex('ec') },
          ram: { base: 0x8000n, bytes: ram },
          io: {
            read() {
              calls++;
              return 0x7b;
            },
            write() {},
          },
        });
        try {
          cpu.setDebugState({ addresses: [0x8066n, 0x8080n, 0n, 0n], dr6: 0n, dr7: 0x770405n });
          cpu.setState(initial(0x1000n));
          const result = await cpu.run({ budget: 1n });
          equal(result.reason, 'budget', 'implicit reads excluded from operand watchpoints');
          equal(calls, 1, 'permission succeeds');
          equal(cpu.readDebugState().dr6 & 15n, 0n, 'no false TSS data hit');
        } finally {
          cpu.dispose();
        }
      },
    },
  ];
}
