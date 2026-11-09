import {
  using,
  snapshot,
  initial,
  same,
  equal,
  throws,
  preserveNumeric,
  FLAGS_MASK,
  type State,
  type Scenario,
} from './fixture.js';

export function stateScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'system flags full state snapshots own boundaries and reject malformed imports atomically',
      async run() {
        await using(compiler, '90', snapshot(), async (cpu) => {
          const numeric = preserveNumeric(cpu);
          cpu.setState(initial());
          await cpu.run({ budget: 1n });
          cpu.setState(initial(0x1000n, {}, FLAGS_MASK));
          const before = cpu.readState();
          const owners = cpu.inspectTranslations();
          for (let bit = 0n; bit < 64n; bit++) {
            if (FLAGS_MASK & (1n << bit)) continue;
            throws(() => cpu.setState({ ...before, flags: 2n | (1n << bit) }), 'reserved flags');
            same(cpu.readState(), before, 'rejected flags retain complete state');
            same(cpu.inspectTranslations(), owners, 'rejected flags retain owners');
          }
          for (const interruptibility of [
            null,
            {},
            [],
            { sti: 0, ss: false },
            { sti: true, ss: true },
          ]) {
            throws(
              () => cpu.setState({ ...before, interruptibility } as State),
              'malformed boundary',
            );
            same(cpu.readState(), before, 'rejected boundary retains complete state');
            same(cpu.inspectTranslations(), owners, 'rejected boundary retains owners');
          }
          throws(
            () => cpu.setState(initial(0x2000n, {}, 2n, { sti: true, ss: false })),
            'STI interval requires IF',
          );
          same(cpu.readState(), before, 'invalid flag/boundary relation is atomic');
          const source = initial(0x1000n, {}, 0x202n, { sti: true, ss: false });
          cpu.setState(source);
          source.interruptibility.sti = false;
          const observed = cpu.readState();
          same(observed.interruptibility, { sti: true, ss: false }, 'owned input boundary');
          observed.interruptibility.sti = false;
          observed.registers[0] = 0n;
          same(cpu.readState().interruptibility, { sti: true, ss: false }, 'detached output');
          const omitted = { registers: before.registers, flags: 2n, rip: 0x1000n };
          cpu.setState(omitted);
          same(cpu.readState().interruptibility, { sti: false, ss: false }, 'legacy input clears');
          numeric();
        });
      },
    },
    {
      name: 'system flags boundary history survives gates and rejected context but equal repair clears it',
      async run() {
        await using(compiler, '90', snapshot(), async (cpu) => {
          const numeric = preserveNumeric(cpu);
          const before = initial(0x1000n, {}, 0x202n, { sti: true, ss: false });
          cpu.setState(before);
          for (const input of [{ budget: 0n }, { budget: 1n, stop: 0x1000n }]) {
            const result = await cpu.run(input);
            same(result.state, before, 'entry gates preserve full state');
            equal(result.retired, 0n, 'entry gate retires nothing');
          }
          const context = cpu.readContext();
          const bad = structuredClone(context);
          bad.segments.fs.base = 0x800000000000n;
          throws(() => cpu.setContext(bad), 'noncanonical FS base');
          same(cpu.readState(), before, 'rejected context retains boundary');
          cpu.setContext(context);
          same(
            cpu.readState(),
            { ...before, interruptibility: { sti: false, ss: false } },
            'equal repair',
          );
          cpu.setState(initial(0x1000n, {}, 2n, { sti: false, ss: true }));
          const imported = cpu.readState();
          cpu.setState(imported);
          same(cpu.readState(), imported, 'explicit complete roundtrip');
          numeric();
        });
      },
    },
  ];
}
