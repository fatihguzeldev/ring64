import {
  changed,
  check,
  equal,
  hex,
  initial,
  longSnapshot,
  noCompilation,
  preserveNumeric,
  same,
  type Factory,
  type Scenario,
} from './fixture.js';
import { fastSetup, FAST_FORMS, KERNEL, USER } from './warm.js';

export function fenceScenarios(compiler: WebAssembly.Module, make: Factory): Scenario[] {
  return [
    {
      name: 'context reuse preserves destructive paging fences even for dormant owners and same-value CR3',
      async run() {
        const packets = [
          { code: '0f22d8', registers: { 0: 0x1000n }, bank: {} },
          { code: '0f22c0', registers: { 0: 0x80000033n }, bank: { cr0: 0x80000033n } },
          { code: '0f30', registers: { 0: 0x501n, 1: 0xc0000080n, 2: 0n }, bank: { efer: 0x501n } },
          { code: '0f0138', registers: { 0: 0x7ffff000n }, bank: {} },
        ];
        for (const packet of packets) {
          const setup = fastSetup(compiler, FAST_FORMS[0]);
          setup.ram.set(hex('9082'), 0x9000);
          setup.ram.set(hex(packet.code + '82'), 0xa000);
          const a = setup.kernel,
            b = longSnapshot(0x403000n, a.segments.gs.base);
          const cpu = await make({ ...setup.options, context: a });
          try {
            const numeric = preserveNumeric(cpu),
              input = initial(USER);
            cpu.setState(input);
            await cpu.run({ budget: 1n });
            const owner = cpu.inspectTranslations()[0]!.owner;
            cpu.setContext(b);
            const before = initial(KERNEL, packet.registers);
            cpu.setState(before);
            const written = await cpu.run({ budget: 1n });
            equal(written.reason, 'budget', 'control writer completes');
            same(
              written.state,
              changed(before, KERNEL + BigInt(packet.code.length / 2)),
              'one committed control instruction',
            );
            same(
              cpu.readPagingState(),
              { ...setup.paging, ...packet.bank },
              'literal resulting bank',
            );
            check(
              !cpu.inspectTranslations().some((entry) => entry.owner === owner),
              'paging fence permanently retires dormant owner',
            );
            cpu.setContext(a);
            cpu.setState(input);
            const returned = await cpu.run({ budget: 1n });
            equal(returned.resources.compilations, 1, 'return after fence must recompile');
            same(returned.state, changed(input, USER + 1n), 'fresh invocation result');
            numeric();
          } finally {
            cpu.dispose();
          }
        }
      },
    },
    {
      name: 'context reuse adds no fences for CR2 SCE equal controls or noncanonical INVLPG',
      async run() {
        const packets = [
          {
            code: '0f22d0',
            registers: { 0: 0x8877665544332211n },
            bank: { cr2: 0x8877665544332211n },
          },
          { code: '0f22c0', registers: { 0: 0x80010033n }, bank: {} },
          { code: '0f22e0', registers: { 0: 0x628n }, bank: {} },
          { code: '0f30', registers: { 0: 0xd01n, 1: 0xc0000080n, 2: 0n }, bank: {} },
          { code: '0f30', registers: { 0: 0xd00n, 1: 0xc0000080n, 2: 0n }, bank: { efer: 0xd00n } },
          { code: '0f0138', registers: { 0: 0x800000000000n }, bank: {} },
          { code: '0f22d8', registers: { 0: 0x8000000000000000n }, bank: {}, rejected: true },
        ];
        for (const packet of packets) {
          const setup = fastSetup(compiler, FAST_FORMS[0]);
          setup.ram.set(hex('9082'), 0x9000);
          setup.ram.set(hex(packet.code + '82'), 0xa000);
          const a = setup.kernel,
            b = longSnapshot(0x403000n, a.segments.gs.base);
          const cpu = await make({ ...setup.options, context: a });
          try {
            const numeric = preserveNumeric(cpu),
              input = initial(USER);
            cpu.setState(input);
            await cpu.run({ budget: 1n });
            const owner = cpu.inspectTranslations()[0]!.owner;
            cpu.setContext(b);
            cpu.setState(initial(KERNEL, packet.registers));
            const written = await cpu.run({ budget: 1n });
            equal(
              written.reason,
              packet.rejected ? 'protection-fault' : 'budget',
              'literal control outcome',
            );
            equal(written.retired, packet.rejected ? 0n : 1n, 'rejected writes have no retirement');
            same(
              cpu.readPagingState(),
              { ...setup.paging, ...packet.bank },
              'literal control update',
            );
            cpu.setPagingState(cpu.readPagingState());
            check(
              cpu.inspectTranslations().some((entry) => entry.owner === owner),
              'no invented fence for unrelated control or equal host import',
            );
            cpu.setContext(a);
            cpu.setState(input);
            await noCompilation(async () => {
              const returned = await cpu.run({ budget: 1n });
              equal(returned.resources.compilations, 0, 'old A remains eligible');
              same(returned.state, changed(input, USER + 1n), 'retained A executes');
            });
            numeric();
          } finally {
            cpu.dispose();
          }
        }
      },
    },
  ];
}
