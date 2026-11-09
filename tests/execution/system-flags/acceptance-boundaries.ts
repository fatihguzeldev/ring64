import {
  createCpu,
  using,
  snapshot,
  initial,
  outcome,
  equal,
  same,
  hex,
  LIMITS,
  preserveNumeric,
  type Scenario,
} from './fixture.js';

const FLAGS = 0x3d7fd7n;
const HISTORY = { sti: false, ss: true };

export function acceptanceBoundaryScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'system RF remains before fetch coverage encoding and resource frontiers with no trap',
      async run() {
        for (const packet of [
          { code: 'b8', reason: 'fetch-fault' },
          { code: '0f05', reason: 'unsupported' },
          { code: 'f09c', reason: 'invalid-encoding' },
          { code: 'f0f39c', reason: 'unsupported' },
          { code: '66'.repeat(15) + '9c', reason: 'invalid-encoding' },
          { code: 'b801000000', reason: 'resource-limit', limits: { maxSourceBytes: 1 } },
          { code: 'b801000000', reason: 'resource-limit', limits: { maxArtifactBytes: 1 } },
          { code: 'b801000000', reason: 'resource-limit', limits: { maxCachedBytes: 1 } },
        ]) {
          await using(
            compiler,
            packet.code,
            snapshot(),
            async (cpu) => {
              const numeric = preserveNumeric(cpu);
              const before = initial(0x1000n, {}, FLAGS, HISTORY);
              cpu.setState(before);
              const result = await cpu.run({ budget: 3n, repeatBudget: 7n });
              outcome(result, packet.reason, 3n, 0n, 7n);
              same(
                result.state,
                before,
                'frontier precedes RF begin and preserves all banks/history',
              );
              equal(result.debugException, undefined, 'no completed boundary');
              numeric();
            },
            packet.limits ? { limits: packet.limits } : {},
          );
        }
        const execution = snapshot('protected');
        execution.segments.cs.limit = 0x1000;
        await using(compiler, 'b801000000', execution, async (cpu) => {
          const numeric = preserveNumeric(cpu);
          const before = initial(0x1000n, {}, FLAGS, HISTORY);
          cpu.setState(before);
          const result = await cpu.run({ budget: 3n, repeatBudget: 7n });
          outcome(result, 'segment-fault', 3n, 0n, 7n);
          same(result.state, before, 'required CS byte precedes RF begin');
          equal(result.segmentFault?.segment, 'cs', 'instruction-fetch segment');
          equal(result.segmentFault?.offset, 0x1001n, 'first denied required byte');
          equal(result.debugException, undefined, 'fetch has not completed an instruction');
          numeric();
        });
      },
    },
    {
      name: 'system begun target descriptor presence privilege and reserved-MXCSR faults clear RF only',
      async run() {
        for (const kind of [
          'target',
          'descriptor-read',
          'absent-ss',
          'privilege',
          'mxcsr',
        ] as const) {
          const execution = snapshot('long64', kind === 'privilege' ? 3 : 0);
          const code = {
            target: 'ffe0',
            'descriptor-read': '8ed0',
            'absent-ss': '8ed0',
            privilege: 'fa',
            mxcsr: '0fae13',
          }[kind];
          const flags = kind === 'privilege' ? 0x3d4fd7n : FLAGS;
          const registers = { 0: kind === 'target' ? 0x800000000001n : 8n, 3: 0x6000n };
          await using(
            compiler,
            code,
            execution,
            async (cpu) => {
              const numeric = preserveNumeric(cpu);
              const before = initial(0x1000n, registers, flags, HISTORY);
              cpu.setState(before);
              const result = await cpu.run({ budget: 3n, repeatBudget: 7n });
              const reason =
                kind === 'target'
                  ? 'target-fault'
                  : kind === 'descriptor-read'
                    ? 'system-memory-fault'
                    : kind === 'mxcsr'
                      ? 'general-protection'
                      : 'protection-fault';
              outcome(result, reason, 3n, 0n, 7n);
              same(
                result.state,
                { ...before, flags: flags & ~0x10000n },
                'begun failure preserves all state except RF',
              );
              same(
                cpu.readContext(),
                execution,
                'failed instruction does not publish descriptor state',
              );
              equal(result.debugException, undefined, 'fault wins over sampled TF');
              if (kind === 'target')
                equal(result.fault?.cause, 'noncanonical', 'invalid target value');
              if (kind === 'descriptor-read') {
                equal(
                  result.systemMemoryFault?.phase,
                  'descriptor-read',
                  'descriptor backing stage',
                );
                equal(result.systemMemoryFault?.address, 0x4008n, 'addressed selector');
              }
              if (kind === 'absent-ss') {
                equal(result.protectionFault?.vector, 12, 'MOV SS presence vector');
                equal(result.protectionFault?.errorCode, 8, 'selector error code');
              }
              if (kind === 'privilege')
                equal(result.protectionFault?.phase, 'privilege', 'CLI privilege stage');
              if (kind === 'mxcsr')
                equal(
                  result.generalProtectionFault?.loadedValue,
                  0x10000,
                  'reserved input captured',
                );
              numeric();
            },
            {
              data:
                kind === 'absent-ss'
                  ? [{ base: 0x4008n, bytes: 'ffff000000120000', write: false }]
                  : kind === 'mxcsr'
                    ? [{ base: 0x6000n, bytes: '00000100', write: false }]
                    : [],
            },
          );
        }
      },
    },
    {
      name: 'system POPF admits full tail before flags SP history or numeric publication at every width',
      async run() {
        for (const width of [2, 4, 8]) {
          const code = width === 2 ? '669d' : '9d';
          const execution = snapshot(width === 4 ? 'protected' : 'long64');
          const data = 'a5' + 'ff'.repeat(width) + 'a5';
          const cpu = await createCpu({
            compiler,
            context: execution,
            entry: 0x1000n,
            limits: LIMITS,
            memoryLimits: { maxBackings: 2, maxMappings: 4, maxBackingBytes: 32 },
            memory: {
              backings: [
                { id: 'code', bytes: hex(code) },
                { id: 'stack', bytes: hex(data) },
              ],
              mappings: [
                {
                  base: 0x1000n,
                  backing: 'code',
                  offset: 0,
                  length: code.length / 2,
                  permissions: { read: true, write: false, execute: true },
                },
                {
                  base: 0x6000n,
                  backing: 'stack',
                  offset: 1,
                  length: width - 1,
                  permissions: { read: true, write: false, execute: false },
                },
                {
                  base: 0x6000n + BigInt(width - 1),
                  backing: 'stack',
                  offset: width,
                  length: 1,
                  permissions: { read: false, write: true, execute: false },
                },
                {
                  base: 0x7000n,
                  backing: 'stack',
                  offset: 0,
                  length: width + 2,
                  permissions: { read: true, write: false, execute: false },
                },
              ],
            },
          });
          try {
            const numeric = preserveNumeric(cpu);
            const before = initial(
              0x1000n,
              { 4: width === 4 ? 0x1122334400006000n : 0x6000n },
              FLAGS,
              HISTORY,
            );
            cpu.setState(before);
            const result = await cpu.run({ budget: 3n, repeatBudget: 7n });
            outcome(result, 'data-fault', 3n, 0n, 7n);
            same(
              result.state,
              { ...before, flags: 0x3c7fd7n },
              'no early flags/SP/history publication',
            );
            equal(result.fault?.address, 0x6000n, 'whole stack slot');
            equal(result.fault?.width, width, 'selected full slot width');
            equal(
              result.fault?.failingAddress,
              0x6000n + BigInt(width - 1),
              'last source byte fails',
            );
            equal(result.fault?.cause, 'permission', 'source-tail read permission');
            equal(result.debugException, undefined, 'no completed POPF step');
            same(cpu.readMemory(0x7000n, width + 2), hex(data), 'source and both backing guards');
            same(cpu.readContext(), execution, 'failure retains old context');
            numeric();
          } finally {
            cpu.dispose();
          }
        }
      },
    },
    {
      name: 'system virtual8086 PUSHF privilege failure precedes both unmapped stack widths and sampled TF',
      async run() {
        for (const code of ['9c', '669c']) {
          await using(compiler, code, snapshot('virtual8086'), async (cpu) => {
            const numeric = preserveNumeric(cpu);
            const before = initial(0x1000n, { 4: 0x6000n }, 0x3d6fd7n, HISTORY);
            cpu.setState(before);
            const result = await cpu.run({ budget: 3n, repeatBudget: 7n });
            outcome(result, 'protection-fault', 3n, 0n, 7n);
            same(
              result.state,
              { ...before, flags: 0x3c6fd7n },
              'denied PUSHF has only RF begin effect',
            );
            equal(result.protectionFault?.vector, 13, 'VME0 privilege failure');
            equal(result.protectionFault?.phase, 'privilege', 'privilege before stack');
            equal(result.fault, undefined, 'unmapped stack is not accessed');
            equal(result.segmentFault, undefined, 'no stack admission before privilege');
            equal(result.debugException, undefined, 'denied PUSHF cannot retire or step');
            numeric();
          });
        }
      },
    },
  ];
}
