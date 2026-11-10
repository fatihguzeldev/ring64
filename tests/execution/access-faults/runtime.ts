import {
  using,
  snapshot,
  initial,
  equal,
  same,
  preserveNumeric,
  type Scenario,
} from '../exception-delivery/fixture.js';
const HOLE = 0x800000000000n;

export function runtimeScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...(
      [
        ['RBX scalar', '488b03', 3, 13],
        ['RSP scalar', '488b0424', 4, 12],
        ['RBP scalar', '488b4500', 5, 12],
        ['ignored SS on RBX', '36488b03', 3, 13],
        ['ignored DS on RSP', '3e488b0424', 4, 12],
        ['FS on RSP', '64488b0424', 4, 13],
        ['store', '488903', 3, 13],
        ['false CMOV', '480f4403', 3, 13],
        ['LOCK RMW', 'f0480103', 3, 13],
        ['pair', '0fc70b', 3, 13],
        ['MMX', '0f6f03', 3, 13],
        ['x87', 'dd03', 3, 13],
        ['vector', '0f1003', 3, 13],
        ['aligned SS vector', '0f280424', 4, 12],
        ['FXSAVE', '0fae03', 3, 13],
        ['FXRSTOR', '0fae0b', 3, 13],
        ['near CALL target', 'ffd3', 3, 13],
        ['near JMP target', 'ffe3', 3, 13],
        ['near CALL pointer SS', 'ff1424', 4, 12],
        ['RET stack', 'c3', 4, 12],
        ['LEAVE stack', 'c9', 5, 12],
        ['MASKMOV zero nominal geometry', '660ff7c1', 7, 13],
      ] as const
    ).map(([name, code, reg, vector]): Scenario => ({
      name: `architectural access ${name} stages effective-segment vector without publishing destination`,
      async run() {
        await using(compiler, code, snapshot(), async (cpu) => {
          cpu.setXmmState(Array<bigint>(16).fill(0n));
          cpu.setState(initial(0x1000n, { [reg]: HOLE }, 0x10202n));
          const before = cpu.readState();
          const numeric = [cpu.readXmmState(), cpu.readMxcsr(), cpu.readX87State()];
          const report = await cpu.run({ budget: 1n });
          equal(report.state.flags, 0x202n, 'post-begin live RF');
          same(report.state.registers, before.registers, 'report scalar atomicity');
          const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
          equal(result.reason, 'event-budget', name);
          equal(result.retired, 0n, 'fault retires zero');
          same(result.state.registers, before.registers, 'fault scalar atomicity');
          same(
            result.state.event,
            {
              kind: 'pending',
              exception: {
                vector,
                instructionPc: 0x1000n,
                returnPc: 0x1000n,
                savedFlags: 0x10202n,
                errorCode: 0,
              },
            },
            'literal source image',
          );
          // MMX/MASKMOV have their inherited early numeric transitions; the others do not.
          if (!name.startsWith('MMX') && !name.startsWith('MASKMOV'))
            same(
              [cpu.readXmmState(), cpu.readMxcsr(), cpu.readX87State()],
              numeric,
              'numeric banks',
            );
        });
      },
    })),
    {
      name: 'architectural access segment limit type null and artificial cache frontiers retain mode ownership',
      async run() {
        for (const mode of ['real', 'virtual8086', 'protected', 'compatibility'] as const)
          for (const [code, segment, vector] of [
            ['8b03', 'ds', 13],
            ['368b03', 'ss', 12],
          ] as const) {
            const execution = snapshot(mode);
            if (mode !== 'virtual8086') execution.segments[segment].limit = 0x5fff;
            await using(
              compiler,
              (mode === 'virtual8086' ? '67' : '') + code,
              execution,
              async (cpu) => {
                cpu.setState(
                  initial(0x1000n, { 3: mode === 'virtual8086' ? 0x10000n : 0x6000n }, 0x10202n),
                );
                const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
                equal(result.reason, 'event-budget', `${mode} ${segment}`);
                equal(
                  result.state.event.kind === 'pending' && result.state.event.exception.vector,
                  vector,
                  'limit vector',
                );
              },
            );
          }
        for (const [segment, selector, selected] of [
          ['ds', 0, true],
          ['ds', 4, false],
          ['ds', 16, false],
        ] as const) {
          const execution = snapshot('protected');
          execution.segments[segment].selector = selector;
          execution.segments[segment].usable = false;
          await using(compiler, '8b03', execution, async (cpu) => {
            cpu.setState(initial(0x1000n, { 3: 0x6000n }));
            const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
            equal(
              result.reason,
              selected ? 'event-budget' : 'segment-fault',
              'null TI and cache provenance',
            );
          });
        }
      },
    },
    {
      name: 'architectural access mandatory alignment is GP even through SS while private permissions stay private',
      async run() {
        for (const [code, address, reason, selected] of [
          ['0f2803', 0x6001n, 'alignment-fault', true],
          ['360f2803', 0x6001n, 'alignment-fault', true],
          ['0fae03', 0x6001n, 'alignment-fault', true],
          ['0fae0b', 0x6001n, 'alignment-fault', true],
          ['0f1003', 0x6001n, 'budget', false],
          ['488b03', 0xfffffffffffffffcn, 'data-fault', false],
          ['488b03', 0x7000n, 'data-fault', false],
        ] as const)
          await using(
            compiler,
            code,
            snapshot(),
            async (cpu) => {
              cpu.setState(initial(0x1000n, { 3: address }));
              const keep = preserveNumeric(cpu);
              const report = await cpu.run({ budget: 1n });
              equal(report.reason, reason, 'report diagnostic');
              if (reason !== 'budget') keep();
              cpu.setState(initial(0x1000n, { 3: address }));
              const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
              equal(result.reason, selected ? 'event-budget' : reason, 'selected boundary');
              if (selected)
                equal(
                  result.state.event.kind === 'pending' && result.state.event.exception.vector,
                  13,
                  'mandatory GP0',
                );
              else same(result.state.event, { kind: 'ready' }, 'private or successful frontier');
            },
            { data: [{ base: 0x6001n, bytes: 'a5'.repeat(32) }] },
          );
      },
    },
    {
      name: 'architectural access instruction fetch before begin retains RF unlike a selected data access',
      async run() {
        const execution = snapshot('protected');
        execution.segments.cs.limit = 0x1000;
        await using(compiler, 'b834120000', execution, async (cpu) => {
          cpu.setState(initial(0x1000n, {}, 0x10202n));
          const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
          equal(result.reason, 'event-budget', 'CS required-byte limit');
          equal(result.state.flags, 0x10202n, 'pre-begin RF preserved');
          equal(
            result.state.event.kind === 'pending' && result.state.event.exception.vector,
            13,
            'CS GP',
          );
        });
      },
    },
  ];
}
