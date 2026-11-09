import {
  using,
  snapshot,
  initial,
  outcome,
  debug,
  same,
  equal,
  check,
  gate,
  withGate,
  CODE64,
  TSS,
  preserveNumeric,
  type Scenario,
} from './fixture.js';

export function diagnosticScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'software IVT IDT and TSS private faults preserve distinct vector or selector provenance',
      async run() {
        for (const mode of ['real', 'protected', 'long64', 'tss', 'overflow'] as const) {
          const execution = snapshot(
            mode === 'tss' || mode === 'overflow' ? 'long64' : mode,
            mode === 'tss' || mode === 'overflow' ? 3 : 0,
          );
          const address = withGate(execution);
          const task = mode === 'tss' || mode === 'overflow';
          if (task)
            execution.tr = {
              ...TSS,
              ...(mode === 'overflow' ? { base: 0xfffffffffffffffcn } : {}),
            };
          await using(
            compiler,
            'cd40',
            execution,
            async (cpu) => {
              const numeric = preserveNumeric(cpu);
              const before = initial(0x1000n, { 4: 0x7000n }, 0x10002n, { sti: false, ss: true });
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n, repeatBudget: 29n });
              outcome(result, 'system-memory-fault', 1n, 0n, 29n);
              same(
                result.state,
                { ...before, flags: 2n },
                'begun RF clears but failed delivery preserves history and scalar state',
              );
              same(cpu.readContext(), execution, 'failed system access preserves context');
              const fault = result.systemMemoryFault;
              check(fault, 'typed system memory fault');
              equal(fault.instructionPc, 0x1000n, 'source instruction PC');
              equal(fault.access, 'read', 'read provenance');
              equal(
                fault.address,
                mode === 'overflow'
                  ? 1n << 64n
                  : task
                    ? 0x5004n
                    : mode === 'real'
                      ? 0x8100n
                      : address,
                'exact attempted system address',
              );
              equal(fault.failingAddress, fault.address, 'first failing attempt');
              equal(
                fault.width,
                task ? 8 : mode === 'real' ? 4 : mode === 'protected' ? 8 : 16,
                'actual selected field width',
              );
              equal(
                fault.cause,
                mode === 'overflow' ? 'address-range' : 'unmapped',
                'private cause',
              );
              if (task) {
                check(fault.table === 'tss', 'TSS root');
                equal(fault.phase, 'tss-read', 'live TSS phase');
                equal(fault.selector, 0x28, 'cached TR selector');
                equal('vector' in fault, false, 'no invented vector for a TSS cache');
              } else {
                check(fault.table === (mode === 'real' ? 'ivt' : 'idt'), 'vector-table root');
                check(
                  fault.table === 'ivt' || fault.table === 'idt',
                  'vector reference discriminant',
                );
                equal(fault.phase, 'gate-read', 'selected entry phase');
                equal(fault.vector, 0x40, 'actual vector');
                equal('selector' in fault, false, 'vector never masquerades as selector');
              }
              numeric();
            },
            {
              data: task
                ? [
                    { base: 0x4008n, bytes: CODE64 },
                    { base: address, bytes: gate(64), write: false },
                  ]
                : [],
            },
          );
        }
      },
    },
    {
      name: 'software TSS usability and canonical fields are architectural TS while loaded bad RSP is SS',
      async run() {
        for (const kind of [
          'invalid',
          'available',
          'system-bit',
          'absent',
          'legacy16',
          'canonical',
          'pointer',
        ] as const) {
          const execution = snapshot('long64', 3);
          const address = withGate(execution);
          execution.tr = { ...TSS };
          if (kind === 'invalid') execution.tr.valid = false;
          if (kind === 'available') execution.tr.attributes = 0x89;
          if (kind === 'system-bit') execution.tr.attributes = 0x9b;
          if (kind === 'absent') execution.tr.attributes = 0x0b;
          if (kind === 'legacy16') execution.tr.attributes = 0x83;
          if (kind === 'canonical') execution.tr.base = 0x7ffffffffffdn;
          await using(
            compiler,
            'cd40',
            execution,
            async (cpu) => {
              const numeric = preserveNumeric(cpu);
              const before = initial(0x1000n, { 4: 0x7000n }, 0x10002n, { sti: false, ss: true });
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              outcome(result, 'protection-fault', 1n, 0n);
              same(
                result.state,
                { ...before, flags: 2n },
                'failed architectural entry preserves prepared state',
              );
              same(cpu.readContext(), execution, 'raw imported root remains raw');
              equal(result.protectionFault?.vector, kind === 'pointer' ? 12 : 10, 'TS versus SS');
              equal(
                result.protectionFault?.errorCode,
                kind === 'pointer' ? 0 : 0x28,
                'exact selected provenance',
              );
              equal(result.systemMemoryFault, undefined, 'no private noncanonical substitute');
              equal(result.fault, undefined, 'no ordinary private noncanonical substitute');
              numeric();
            },
            {
              data: [
                { base: 0x4008n, bytes: CODE64 },
                { base: address, bytes: gate(64), write: false },
                ...(kind === 'pointer'
                  ? [{ base: 0x5004n, bytes: '0000000000800000', write: false }]
                  : []),
              ],
            },
          );
        }
      },
    },
    {
      name: 'software INT1 differs from CD01 in DPL bypass and EXT error provenance',
      async run() {
        for (const [code, vector, exception, error] of [
          ['cd01', 1, 13, 0x0a],
          ['f1', 1, 11, 0x0b],
          ['cc', 3, 13, 0x1a],
          ['ce', 4, 13, 0x22],
        ] as const) {
          const execution = snapshot('protected', 3);
          const address = withGate(execution, vector);
          const descriptor = gate(32, 8, 0x2000n, 0);
          // Not present: ordinary software events must fail DPL first, INT1 reaches P.
          const absent = descriptor.slice(0, 10) + '0e' + descriptor.slice(12);
          await using(
            compiler,
            code,
            execution,
            async (cpu) => {
              const numeric = preserveNumeric(cpu);
              const before = initial(0x1000n, { 4: 0x7000n }, code === 'ce' ? 0x10802n : 0x10002n);
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              outcome(result, 'protection-fault', 1n, 0n);
              same(
                result.state,
                { ...before, flags: before.flags & ~0x10000n },
                'begun flags and precise fault',
              );
              equal(result.protectionFault?.vector, exception, 'DPL versus presence');
              equal(result.protectionFault?.errorCode, error, 'IDT selector encoding and EXT');
              equal(
                result.protectionFault?.selector,
                undefined,
                'IDT vector is not a code selector',
              );
              same(cpu.readContext(), execution, 'no target cache publication');
              equal(
                result.systemMemoryFault,
                undefined,
                'unselected target descriptor is not read',
              );
              numeric();
            },
            { data: [{ base: address, bytes: absent, write: false }] },
          );
        }
      },
    },
    {
      name: 'software INTO OF0 completes and steps without gate access while virtual INT obeys IOPL admission',
      async run() {
        await using(compiler, 'ce', snapshot('protected'), async (cpu) => {
          const numeric = preserveNumeric(cpu);
          const before = initial(0x1000n, {}, 0x10703n);
          cpu.setState(before);
          const result = await cpu.run({ budget: 1n, stop: 0x1001n });
          outcome(result, 'debug-exception', 1n, 1n);
          debug(result, 0x1000n, 0x1001n, true, 0x703n);
          same(
            result.state.registers,
            before.registers,
            'ordinary non-delivery preserves registers',
          );
          equal(result.state.flags, 0x703n, 'RF clears at ordinary begin');
          numeric();
        });
        const execution = snapshot('virtual8086');
        await using(compiler, 'cd40', execution, async (cpu) => {
          const numeric = preserveNumeric(cpu);
          const before = initial(0x1000n, {}, 0x12002n, { sti: false, ss: true });
          cpu.setState(before);
          const result = await cpu.run({ budget: 1n });
          outcome(result, 'protection-fault', 1n, 0n);
          same(
            result.state,
            { ...before, flags: 0x2002n },
            'IOPL refusal preserves old VM and history',
          );
          equal(result.protectionFault?.vector, 13, 'V86 GP');
          equal(result.protectionFault?.errorCode, 0, 'V86 GP0');
          equal(result.systemMemoryFault, undefined, 'IOPL precedes unmapped IDT');
          same(cpu.readContext(), execution, 'VM remains context owned');
          numeric();
        });
      },
    },
    {
      name: 'software NT task return frontier occurs after begin and before any ordinary stack read',
      async run() {
        for (const mode of ['protected', 'compatibility', 'long64'] as const)
          await using(compiler, 'cf', snapshot(mode), async (cpu) => {
            const numeric = preserveNumeric(cpu);
            const before = initial(0x1000n, { 4: 0x9000n }, 0x14002n, { sti: false, ss: true });
            cpu.setState(before);
            const result = await cpu.run({ budget: 1n });
            outcome(result, mode === 'protected' ? 'unsupported' : 'protection-fault', 1n, 0n);
            same(
              result.state,
              { ...before, flags: 0x4002n },
              'task frontier retains history without resurrecting RF',
            );
            equal(result.fault, undefined, 'ordinary source stack not read');
            equal(result.systemMemoryFault, undefined, 'task body not read');
            if (mode !== 'protected') {
              equal(result.protectionFault?.vector, 13, 'IA32e GP');
              equal(result.protectionFault?.errorCode, 0, 'IA32e GP0');
            }
            numeric();
          });
      },
    },
  ];
}
