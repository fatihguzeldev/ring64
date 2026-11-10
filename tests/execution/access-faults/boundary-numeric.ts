import {
  using,
  snapshot,
  initial,
  same,
  equal,
  createCpu,
  LIMITS,
  hex,
  type Scenario,
} from '../exception-delivery/fixture.js';

const HOLE = 0x800000000000n;

export function boundaryNumericScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'architectural boundary waiting numeric MF outranks new operand faults while nonwaiting FXSAVE selects GP',
      async run() {
        for (const [code, register, vector] of [
          ['dd03', 3, 16],
          ['0f6f03', 3, 16],
          ['0ff7c1', 7, 16],
          ['0fae03', 3, 13],
        ] as const) {
          await using(compiler, code, snapshot(), async (cpu) => {
            const bank = cpu.readX87State();
            cpu.setX87State({
              ...bank,
              registers: bank.registers.map((_, index) => BigInt(index + 1)),
              controlWord: 0x37e,
              statusWord: 0x8081,
              instructionPointer: 0x4444n,
              dataPointer: 0x5555n,
              opcode: 0x123,
            });
            cpu.setXmmState(Array<bigint>(16).fill(0n));
            cpu.setState(initial(0x1000n, { [register]: HOLE }, 0x10202n));
            const before = cpu.readState();
            const numeric = [cpu.readX87State(), cpu.readXmmState(), cpu.readMxcsr()];
            const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
            equal(result.reason, 'event-budget', 'selected numeric/access source');
            equal(result.retired, 0n, 'numeric checker does not retire');
            same(result.state.registers, before.registers, 'no operand destination');
            equal(
              result.state.flags,
              vector === 16 ? 0x10202n : 0x202n,
              'pending-before-begin RF priority',
            );
            same(
              result.state.event,
              {
                kind: 'pending',
                exception: {
                  vector,
                  instructionPc: 0x1000n,
                  returnPc: 0x1000n,
                  savedFlags: 0x10202n,
                  ...(vector === 13 ? { errorCode: 0 } : {}),
                },
              },
              'exact selected source, not lower-priority operand',
            );
            same(
              [cpu.readX87State(), cpu.readXmmState(), cpu.readMxcsr()],
              numeric,
              'raw deferred environment and numeric payloads',
            );
          });
        }
      },
    },
    {
      name: 'architectural boundary false CMOV LOCK for-write and zero MASKMOV private permissions never fabricate a source',
      async run() {
        for (const [code, register, read, write, width, access] of [
          ['480f4403', 3, false, true, 8, 'read'],
          ['f0480103', 3, true, false, 8, 'write'],
          ['660ff7c1', 7, true, false, 16, 'write'],
        ] as const) {
          await using(
            compiler,
            code,
            snapshot(),
            async (cpu) => {
              cpu.setXmmState(Array<bigint>(16).fill(0n));
              cpu.setState(initial(0x1000n, { [register]: 0x6000n }, 0x10202n));
              const before = cpu.readState();
              const numeric = [cpu.readX87State(), cpu.readXmmState(), cpu.readMxcsr()];
              const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 1n } });
              equal(result.reason, 'data-fault', 'private permission remains private');
              equal(result.retired, 0n, 'no failed instruction retirement');
              equal(result.deliveryAttempts, 0n, 'no automatic entry attempt');
              same(result.state.event, { kind: 'ready' }, 'no fabricated GP/PF');
              same(result.state.registers, before.registers, 'all GPR destinations preserved');
              equal(result.state.flags, 0x202n, 'only begin clears RF');
              equal(result.fault?.cause, 'permission', 'precise private cause');
              equal(result.fault?.width, width, 'full requested width');
              equal(result.fault?.access, access, 'read versus for-write admission');
              same(
                [cpu.readX87State(), cpu.readXmmState(), cpu.readMxcsr()],
                numeric,
                'numeric state unchanged',
              );
              if (read)
                same(
                  cpu.readMemory(0x6000n, 16),
                  new Uint8Array(16).fill(0xa5),
                  'whole destination guard',
                );
            },
            { data: [{ base: 0x6000n, bytes: 'a5'.repeat(16), read, write }] },
          );
        }
      },
    },
    {
      name: 'architectural boundary PREFETCH and LEA do no geometry access while valid zero MASKMOV admits without a write footprint',
      async run() {
        await using(compiler, '0f1803488d03', snapshot(), async (cpu) => {
          cpu.setState(initial(0x1000n, { 3: HOLE }, 0x10202n));
          const result = await cpu.run({ budget: 2n, eventDelivery: { budget: 1n } });
          equal(result.reason, 'budget', 'no selected access from hint/address calculation');
          equal(result.retired, 2n, 'both nonaccess operations retire');
          equal(result.deliveryAttempts, 0n, 'no fabricated entry');
          equal(result.state.registers[0], HOLE, 'LEA preserves raw noncanonical offset');
          same(result.state.event, { kind: 'ready' }, 'no pending source');
        });
        const bytes = hex('660ff7c1' + '90'.repeat(12));
        const cpu = await createCpu({
          compiler,
          limits: LIMITS,
          entry: 0x1000n,
          memory: {
            backings: [{ id: 'alias', bytes }],
            mappings: [
              {
                base: 0x1000n,
                backing: 'alias',
                offset: 0,
                length: 16,
                permissions: { read: true, write: false, execute: true },
              },
              {
                base: 0x6000n,
                backing: 'alias',
                offset: 0,
                length: 16,
                permissions: { read: false, write: true, execute: false },
              },
            ],
          },
          memoryLimits: { maxBackings: 1, maxMappings: 2, maxBackingBytes: 16 },
        });
        try {
          cpu.setXmmState(Array<bigint>(16).fill(0n));
          cpu.setState(initial(0x1000n, { 7: 0x6000n }, 0x10202n));
          const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 1n } });
          equal(
            result.reason,
            'budget',
            'write-only nominal admission requires no destination read',
          );
          equal(result.retired, 1n, 'zero-mask instruction retires');
          equal(result.deliveryAttempts, 0n, 'no architectural source');
          same(cpu.readMemory(0x1000n, 16), bytes, 'whole aliased code backing unchanged');
          equal(
            result.resources.cachedArtifacts,
            1,
            'zero mask did not invalidate its executable alias',
          );
          equal(cpu.inspectTranslations().length, 1, 'artifact owner retained');
        } finally {
          cpu.dispose();
        }
      },
    },
  ];
}
