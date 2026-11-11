import { createCpu, equal, hex, physicalCpu, resetContext, type Scenario } from './fixture.js';
import { LIMITS } from '../../support/fixture.js';
function protected32() {
  const c = resetContext();
  c.mode = 'protected';
  c.segments.cs = {
    ...c.segments.cs,
    selector: 8,
    base: 0n,
    type: 'readable-code',
    default32: true,
    limit: 0xffffffff,
  };
  return c;
}
export function negativeScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'warm physical control failures preserve all banks and distinguish architectural invalidity from deferred facilities',
      async run() {
        const cases: Array<[string, bigint, string]> = [
          ['0f22c0', 0x80000032n, 'protection-fault'],
          ['0f22c0', 0x20000033n, 'protection-fault'],
          ['0f22c0', 0x40033n, 'unsupported'],
          ['0f22e0', 0x8000n, 'protection-fault'],
          ['0f22e0', 0x20000n, 'protection-fault'],
          ['0f22e0', 0x80n, 'unsupported'],
        ];
        for (const [code, value, reason] of cases) {
          const ram = new Uint8Array(0x10000);
          ram.set(hex(code), 0x1000);
          const cpu = await physicalCpu(
            compiler,
            ram,
            new Uint8Array(0x10000),
            { cr0: 0x33n, cr2: 0xdeadn, cr3: 0xdead000n, cr4: 0x608n, efer: 0n },
            protected32(),
          );
          try {
            const registers = Array<bigint>(16).fill(0n);
            registers[0] = value;
            cpu.setState({ registers, flags: 0x10002n, rip: 0x1000n });
            const result = await cpu.run({ budget: 1n });
            equal(result.reason, reason, code + ' value ' + value);
            equal(result.retired, 0n, 'failed writer');
            equal(cpu.readPagingState().cr0, 0x33n, 'CR0 unchanged');
            equal(cpu.readPagingState().cr4, 0x608n, 'CR4 unchanged');
            equal(cpu.readPagingState().cr2, 0xdeadn, 'CR2 unchanged');
            equal(result.state.rip, 0x1000n, 'writer RIP unchanged');
            equal(result.state.flags, 2n, 'ordinary reached writer clears RF');
          } finally {
            cpu.dispose();
          }
        }
        for (const task of [false, true]) {
          const context = protected32();
          if (task)
            context.tr = {
              selector: 0x28,
              valid: true,
              base: 0x2000n,
              limit: 0x67,
              attributes: 0x83,
            };
          else context.segments.cs.long = true;
          const ram = new Uint8Array(0x10000);
          ram.set(hex('0f22c0'), 0x1000);
          const cpu = await physicalCpu(
            compiler,
            ram,
            new Uint8Array(0x10000),
            { cr0: 0x33n, cr2: 0n, cr3: 0xdead000n, cr4: 0x628n, efer: 0x100n },
            context,
          );
          try {
            const registers = Array<bigint>(16).fill(0n);
            registers[0] = 0x80040033n;
            cpu.setState({ registers, flags: 2n, rip: 0x1000n });
            const result = await cpu.run({ budget: 1n });
            equal(result.reason, 'protection-fault', 'loaded restriction before deferred AM');
            equal(result.retired, 0n, 'activation refused');
            equal(cpu.readContext().mode, 'protected', 'no mode publication');
            equal(cpu.readPagingState().efer, 0x100n, 'no LMA publication');
          } finally {
            cpu.dispose();
          }
        }
      },
    },
    {
      name: 'physical nonlong MOV CR merges read parents but guest writes zero raw upper control bits',
      async run() {
        const ram = new Uint8Array(0x10000);
        ram.set(hex('0f20d00f22d00f20d00f20d8'), 0x1000);
        const cpu = await physicalCpu(
          compiler,
          ram,
          new Uint8Array(0x10000),
          { cr0: 0x33n, cr2: 0xfedcba9876543210n, cr3: 0x8000000003018n, cr4: 0x608n, efer: 0n },
          protected32(),
        );
        try {
          const registers = Array<bigint>(16).fill(0n);
          registers[0] = 0x1122334400000000n;
          cpu.setState({ registers, flags: 2n, rip: 0x1000n });
          const first = await cpu.run({ budget: 1n });
          equal(first.state.registers[0], 0x1122334476543210n, 'MOV from CR2 parent');
          const writer = await cpu.run({ budget: 1n });
          equal(writer.retired, 1n, 'MOV to CR2');
          equal(cpu.readPagingState().cr2, 0x76543210n, 'guest write zeroes upper');
          await cpu.run({ budget: 2n });
          equal(
            cpu.readState().registers[0],
            0x1122334400003018n,
            'MOV from raw retained CR3 uses low32',
          );
          equal(
            cpu.readPagingState().cr3,
            0x8000000003018n,
            'read projection does not truncate bank',
          );
        } finally {
          cpu.dispose();
        }
      },
    },
    {
      name: 'nonlong complete-span refusal precedes PG0 adapter and cannot wrap into low physical bytes',
      async run() {
        const context = protected32();
        context.segments.ds = {
          ...context.segments.ds,
          base: 0xfffffff0n,
          limit: 0xffffffff,
          default32: true,
        };
        const ram = new Uint8Array(0x10000);
        ram.set(hex('8b05100000008b050f000000'), 0x1000);
        ram[0] = 0x5a;
        const cpu = await physicalCpu(
          compiler,
          ram,
          new Uint8Array(0x10000),
          { cr0: 0x33n, cr2: 0xdeadn, cr3: 0n, cr4: 0n, efer: 0n },
          context,
        );
        try {
          cpu.setState({ registers: Array<bigint>(16).fill(0n), flags: 2n, rip: 0x1000n });
          const wrappedStart = await cpu.run({ budget: 1n });
          equal(wrappedStart.retired, 1n, 'formed start wraps once');
          equal(wrappedStart.state.registers[0], 0x5an, 'identity low-byte load');
          const span = await cpu.run({ budget: 1n });
          equal(span.reason, 'data-fault', 'inherited complete span refusal');
          equal(span.fault?.address, 0xffffffffn, 'formed span start');
          equal(span.fault?.width, 4, 'complete operand width');
          equal(span.fault?.cause, 'address-range', 'no cross-domain wrap');
          equal(span.fault?.failingAddress, 0x100000000n, 'first rejected linear byte');
          equal(span.physicalMemoryFault, undefined, 'no invented adapter phase');
          equal(span.retired, 0n, 'no split operand');
          equal(cpu.readPagingState().cr2, 0xdeadn, 'no PF');
        } finally {
          cpu.dispose();
        }
      },
    },
    {
      name: 'rejected reset preserves wrong-model captures and a failed physical provider cannot be reopened',
      async run() {
        const linear = await createCpu({
          compiler,
          code: { base: 0x1000n, bytes: hex('90') },
          ram: { base: 0x4000n, bytes: new Uint8Array(16) },
          limits: LIMITS,
        });
        try {
          let denied = false;
          linear.setState({
            get registers() {
              try {
                linear.reset();
              } catch {
                denied = true;
              }
              return Array<bigint>(16).fill(0n);
            },
            flags: 2n,
            rip: 0x1000n,
          });
          equal(denied, true, 'wrong model reset rejected');
          equal((await linear.run({ budget: 1n })).retired, 1n, 'rejection keeps token usable');
        } finally {
          linear.dispose();
        }
        const rom = new Uint8Array(0x10000);
        rom.set(hex('e480'), 0xfff0);
        let effects = 0;
        const failed = await physicalCpu(
          compiler,
          new Uint8Array(0x10000),
          rom,
          undefined,
          undefined,
          {
            io: {
              read() {
                effects++;
                throw new Error('external effect then throw');
              },
              write() {},
            },
          },
        );
        let trapped = false;
        try {
          await failed.run({ budget: 1n });
        } catch {
          trapped = true;
        }
        equal(trapped, true, 'provider poisoned CPU');
        let denied = false;
        try {
          failed.reset();
        } catch {
          denied = true;
        }
        equal(denied, true, 'failed reset rejected');
        equal(effects, 1, 'no retry or reset provider replay');
        failed.dispose();
      },
    },
    {
      name: 'VM86 DE legality precedes privilege while aliases retain privilege before GD',
      async run() {
        for (const de of [false, true]) {
          const context = resetContext();
          context.mode = 'virtual8086';
          context.cpl = 3;
          context.segments.cs.selector = 0;
          context.segments.cs.base = 0n;
          const ram = new Uint8Array(0x10000);
          ram.set(hex('0f21e0'), 0x1000);
          const cpu = await physicalCpu(
            compiler,
            ram,
            new Uint8Array(0x10000),
            { cr0: 0x33n, cr2: 0n, cr3: 0n, cr4: de ? 8n : 0n, efer: 0n },
            context,
          );
          try {
            cpu.setState({ registers: Array<bigint>(16).fill(0n), flags: 2n, rip: 0x1000n });
            cpu.setDebugState({ addresses: [0n, 0n, 0n, 0n], dr6: 0xffff0ff0n, dr7: 0x2400n });
            const result = await cpu.run({ budget: 1n });
            equal(result.reason, de ? 'invalid-encoding' : 'protection-fault', 'VM86 order');
            if (!de) equal(result.protectionFault?.phase, 'privilege', 'CPL before GD');
            equal(cpu.readDebugState().dr6, 0xffff0ff0n, 'no general detect');
            equal(cpu.readDebugState().dr7, 0x2400n, 'GD remains live');
          } finally {
            cpu.dispose();
          }
        }
      },
    },
    {
      name: 'DE changes revoke primed middle-entry owners across A B A while PG0 INVLPG touches no target',
      async run() {
        const context = protected32(),
          ram = new Uint8Array(0x10000);
        ram.set(hex('900f21e0'), 0x1000);
        ram.set(hex('0f013d0000f0ff'), 0x1100);
        const cpu = await physicalCpu(
          compiler,
          ram,
          new Uint8Array(0x10000),
          { cr0: 0x33n, cr2: 0xdeadn, cr3: 0xdead000n, cr4: 0n, efer: 0n },
          context,
        );
        try {
          cpu.setState({ registers: Array<bigint>(16).fill(0n), flags: 2n, rip: 0x1000n });
          await cpu.run({ budget: 2n });
          const owner = cpu.inspectTranslations()[0]!.owner;
          cpu.setState({ ...cpu.readState(), rip: 0x1001n });
          cpu.setPagingState({ ...cpu.readPagingState(), cr4: 8n });
          equal(cpu.inspectTranslations().length, 0, 'DE fence clears host owners');
          const disabled = await cpu.run({ budget: 1n });
          equal(disabled.reason, 'invalid-encoding', 'cold disabled middle');
          equal(disabled.resources.compilations, 0, 'legality probe before compile');
          cpu.setPagingState({ ...cpu.readPagingState(), cr4: 0n });
          const enabled = await cpu.run({ budget: 1n });
          equal(enabled.retired, 1n, 're-enabled alias');
          equal(
            cpu.inspectTranslations().some((x) => x.owner === owner),
            false,
            'dead A cannot revive',
          );
          cpu.setState({ ...cpu.readState(), rip: 0x1100n });
          const invlpg = await cpu.run({ budget: 1n });
          equal(invlpg.retired, 1n, 'PG0 INVLPG admitted');
          equal(invlpg.reason, 'budget', 'no target memory access');
          equal(cpu.readPagingState().cr2, 0xdeadn, 'no synthetic PF');
        } finally {
          cpu.dispose();
        }
      },
    },
  ];
}
