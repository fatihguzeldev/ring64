import {
  createCpu,
  type MemoryMapping,
  type RunResult,
  type X87State,
} from '../../../host/index.js';
import { LIMITS } from '../../support/fixture.js';
import {
  LONG,
  context,
  input,
  changed,
  outcome,
  stack,
  clone,
  seed,
  other,
  x87,
  banks,
  xmm,
  equal,
  bytes,
  hex,
  memory,
  fault,
  using,
  noFault,
  ONE,
  OTHER_MXCSR,
  type Scenario,
} from '../x87/fixture.js';

const map = (
  base: bigint,
  backing: string,
  length: number,
  read = true,
  write = true,
  offset = 0,
  execute = false,
): MemoryMapping => ({ base, backing, offset, length, permissions: { read, write, execute } });

function afterStore(code: string, before: X87State): X87State {
  const after = clone(before);
  if (code === '0f7f03') {
    after.statusWord &= ~0x3800;
    after.tagWord = 0;
  } else if (code === 'd933') {
    after.controlWord |= 0x3f;
    after.statusWord &= ~0x8080;
  } else if (code === 'dd33') {
    after.controlWord = 0x37f;
    after.statusWord = 0;
    after.tagWord = 0xffff;
    after.instructionPointer = 0n;
    after.dataPointer = 0n;
    after.opcode = 0;
  }
  return after;
}

function exclusive(result: RunResult, chosen: string): void {
  for (const field of [
    'fault',
    'segmentFault',
    'alignmentFault',
    'generalProtectionFault',
    'simdException',
    'x87Exception',
  ] as const) {
    if (field !== chosen) equal(result[field], undefined, `exclusive ${field}`);
  }
}

export function boundaryScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'MMX public resumes keep address faults exclusive across repaired budget stop and typed outcomes',
      async run() {
        const code = hex('0f6f030fd4c10fae0790');
        const data = hex('a5'.repeat(8) + '0807060504030201' + 'a5'.repeat(8));
        const mappings = [
          map(0x1000n, 'code', code.length, true, false, 0, true),
          map(0x6000n, 'data', 7, true, false, 8),
          map(0x8000n, 'data', data.length, true, false),
        ];
        const cpu = await createCpu({
          compiler,
          limits: LIMITS,
          entry: 0x1000n,
          memoryLimits: { maxBackings: 2, maxMappings: 3, maxBackingBytes: 1024 },
          memory: {
            backings: [
              { id: 'code', bytes: code },
              { id: 'data', bytes: data },
            ],
            mappings,
          },
        });
        try {
          const before = input(0x1000n, { 3: 0x6000n, 7: 0x6001n }, 0xcd7n);
          const numeric = stack({ 0: ONE }, 5);
          numeric.registers[1] = 7n;
          cpu.setState(before);
          seed(cpu, numeric);
          const encode = (value: unknown) =>
            JSON.stringify(value, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
          const execution = encode(cpu.readContext());
          const preserve = (expected: X87State, result: RunResult) => {
            equal(result.state.interruptibility.sti, false, 'resumes retain STI history');
            equal(result.state.interruptibility.ss, false, 'resumes retain SS history');
            for (const field of ['protectionFault', 'systemMemoryFault', 'debugException'] as const)
              equal(result[field], undefined, `exclusive ${field}`);
            x87(cpu, expected);
            other(cpu);
            equal(encode(cpu.readContext()), execution, 'resumes retain complete context');
            memory(cpu, 0x1000n, '0f6f030fd4c10fae0790');
            memory(cpu, 0x8000n, 'a5'.repeat(8) + '0807060504030201' + 'a5'.repeat(8));
          };
          const failed = await cpu.run({ budget: 3n, repeatBudget: 13n });
          outcome(failed, 'data-fault', 3n, 0n, 13n, 0n, before);
          fault(failed, {
            instructionPc: 0x1000n,
            address: 0x6000n,
            width: 8,
            access: 'read',
            cause: 'unmapped',
            failingAddress: 0x6007n,
            segment: 'ds',
          });
          exclusive(failed, 'fault');
          preserve(numeric, failed);
          cpu.setMappings(
            mappings.map((mapping) =>
              mapping.base === 0x6000n ? { ...mapping, length: 8 } : mapping,
            ),
          );
          const loaded = await cpu.run({ budget: 1n, repeatBudget: 13n });
          outcome(loaded, 'budget', 1n, 1n, 13n, 0n, changed(before, 0x1003n));
          noFault(loaded);
          const after = clone(numeric);
          after.statusWord &= ~0x3800;
          after.tagWord = 0;
          after.registers[0] = 0xffff0102030405060708n;
          preserve(after, loaded);
          const stopped = await cpu.run({ budget: 1n, stop: 0x1003n, repeatBudget: 13n });
          outcome(stopped, 'stop', 1n, 0n, 13n, 0n, changed(before, 0x1003n));
          noFault(stopped);
          preserve(after, stopped);
          const added = await cpu.run({ budget: 1n, repeatBudget: 13n });
          outcome(added, 'budget', 1n, 1n, 13n, 0n, changed(before, 0x1006n));
          noFault(added);
          after.registers[0] = 0xffff010203040506070fn;
          preserve(after, added);
          const aligned = await cpu.run({ budget: 1n, repeatBudget: 13n });
          outcome(aligned, 'alignment-fault', 1n, 0n, 13n, 0n, changed(before, 0x1006n));
          exclusive(aligned, 'alignmentFault');
          equal(aligned.alignmentFault?.instructionPc, 0x1006n, 'typed save PC');
          equal(aligned.alignmentFault?.address, 0x6001n, 'typed save address');
          equal(aligned.alignmentFault?.width, 512, 'typed save width');
          equal(aligned.alignmentFault?.alignment, 16, 'typed save alignment');
          equal(aligned.alignmentFault?.segment, 'ds', 'typed save segment');
          equal(aligned.alignmentFault?.offset, 0x6001n, 'typed save offset');
          equal(aligned.alignmentFault?.access, 'write', 'typed save access');
          preserve(after, aligned);
          for (const [budget, stop, reason] of [
            [1n, 0x1006n, 'stop'],
            [0n, undefined, 'budget'],
          ] as const) {
            const result = await cpu.run({ budget, stop, repeatBudget: 13n });
            outcome(result, reason, budget, 0n, 13n, 0n, changed(before, 0x1006n));
            noFault(result);
            preserve(after, result);
          }
        } finally {
          cpu.dispose();
        }
      },
    },
    {
      name: 'MMX and numeric image stores need only W and late admission failures suppress bytes and post-effects',
      async run() {
        for (const [code, width] of [
          ['0f7f03', 8],
          ['d933', 28],
          ['dd33', 108],
          ['0fae03', 512],
        ] as const) {
          const mappings = [
            map(0x1000n, 'code', code.length / 2, true, false, 0, true),
            map(0x6000n, 'data', width - 1, false, true, 8),
            map(0x8000n, 'data', width + 16, true, false),
          ];
          const cpu = await createCpu({
            compiler,
            limits: LIMITS,
            entry: 0x1000n,
            memoryLimits: { maxBackings: 2, maxMappings: 3, maxBackingBytes: 1024 },
            memory: {
              backings: [
                { id: 'code', bytes: hex(code) },
                { id: 'data', bytes: new Uint8Array(width + 16).fill(0xa5) },
              ],
              mappings,
            },
          });
          try {
            const before = input(0x1000n, { 3: 0x6000n }, 0xcd7n);
            const numeric =
              code === '0f7f03' ? stack({ 0: ONE }, 5) : stack({ 0: ONE }, 5, 0x37b, 0x8084);
            cpu.setState(before);
            seed(cpu, numeric);
            const failed = await cpu.run({ budget: 1n, repeatBudget: 13n });
            outcome(failed, 'data-fault', 1n, 0n, 13n, 0n, before);
            fault(failed, {
              instructionPc: 0x1000n,
              address: 0x6000n,
              width,
              access: 'write',
              cause: 'unmapped',
              failingAddress: 0x6000n + BigInt(width - 1),
              segment: 'ds',
            });
            exclusive(failed, 'fault');
            x87(cpu, numeric);
            other(cpu);
            memory(cpu, 0x8000n, 'a5'.repeat(width + 16));
            equal(failed.resources.cachedArtifacts, 1, 'failed save keeps source owner');
            cpu.setMappings(
              mappings.map((mapping) =>
                mapping.base === 0x6000n ? { ...mapping, length: width } : mapping,
              ),
            );
            const saved = await cpu.run({ budget: 1n, repeatBudget: 13n });
            outcome(
              saved,
              'budget',
              1n,
              1n,
              13n,
              0n,
              changed(before, 0x1000n + BigInt(code.length / 2)),
            );
            noFault(saved);
            x87(cpu, afterStore(code, numeric));
            other(cpu);
            memory(cpu, 0x8000n, 'a5'.repeat(8));
            memory(cpu, 0x8008n + BigInt(width), 'a5'.repeat(8));
            if (code === '0f7f03')
              memory(cpu, 0x8008n, bytes(numeric.registers[0]! & ((1n << 64n) - 1n), 8));
            else memory(cpu, 0x8008n, bytes(BigInt(numeric.controlWord), 2));
            if (code === '0fae03') {
              memory(cpu, 0x8008n + 416n, 'a5'.repeat(96));
              for (let i = 0; i < 8; i++)
                memory(cpu, 0x8008n + 42n + BigInt(16 * i), 'a5'.repeat(6));
            }
          } finally {
            cpu.dispose();
          }
        }
      },
    },
    {
      name: 'FXSAVE invalidates actual executable fields while padding and software tail aliases keep their owner',
      async run() {
        for (const offset of [42, 160, 464]) {
          const storage = new Uint8Array(512).fill(0xa5);
          storage.set(hex('0fae0390'), offset);
          const cpu = await createCpu({
            compiler,
            limits: LIMITS,
            entry: 0x1000n,
            memoryLimits: { maxBackings: 1, maxMappings: 3, maxBackingBytes: 512 },
            memory: {
              backings: [{ id: 'image', bytes: storage }],
              mappings: [
                map(0x1000n, 'image', 4, true, false, offset, true),
                map(0x6000n, 'image', 512, false),
                map(0x8000n, 'image', 512, true, false),
              ],
            },
          });
          try {
            const before = input(0x1000n, { 3: 0x6000n }, 0xcd7n),
              numeric = stack({ 0: ONE }, 5),
              vector = banks();
            vector[0] = 0x9003ae0fn;
            cpu.setState(before);
            cpu.setX87State(numeric);
            cpu.setXmmState(vector);
            cpu.setMxcsr(OTHER_MXCSR);
            const result = await cpu.run({ budget: 2n, repeatBudget: 13n });
            outcome(result, 'budget', 2n, 2n, 13n, 0n, changed(before, 0x1004n));
            noFault(result);
            x87(cpu, numeric);
            xmm(cpu, vector);
            equal(cpu.readMxcsr(), OTHER_MXCSR, 'save preserves MXCSR');
            memory(cpu, 0x1000n, '0fae0390');
            equal(
              result.resources.dispatches,
              offset === 160 ? 1 : 0,
              'actual written source dispatch',
            );
            equal(
              result.resources.nativeEntries,
              offset === 160 ? 2 : 1,
              'actual written source entries',
            );
            equal(
              result.resources.compilations,
              offset === 160 ? 2 : 1,
              'actual written source compilation',
            );
            equal(result.resources.cachedArtifacts, 1, 'one live owner');
            memory(
              cpu,
              0x8000n + 416n,
              offset === 464 ? 'a5'.repeat(48) + '0fae0390' + 'a5'.repeat(44) : 'a5'.repeat(96),
            );
          } finally {
            cpu.dispose();
          }
        }
      },
    },
    {
      name: 'FNSAVE and FNSTENV complete post-effects once before SMC budget stop and successor execution',
      async run() {
        for (const [code, width] of [
          ['d933', 28],
          ['dd33', 108],
        ] as const) {
          for (const [budget, stop] of [
            [1n, false],
            [2n, true],
            [2n, false],
          ] as const) {
            const storage = new Uint8Array(width).fill(0xa5);
            storage.set(hex(code + '90'));
            const cpu = await createCpu({
              compiler,
              limits: LIMITS,
              entry: 0x1000n,
              memoryLimits: { maxBackings: 1, maxMappings: 3, maxBackingBytes: 128 },
              memory: {
                backings: [{ id: 'image', bytes: storage }],
                mappings: [
                  map(0x1000n, 'image', 3, true, false, 0, true),
                  map(0x6000n, 'image', width, false),
                  map(0x8000n, 'image', width, true, false),
                ],
              },
            });
            try {
              const before = input(0x1000n, { 3: 0x6000n }, 0xcd7n),
                numeric = stack({ 0: ONE }, 5, 0x37b, 0x8084);
              cpu.setState(before);
              seed(cpu, numeric);
              const result = await cpu.run({
                budget,
                repeatBudget: 13n,
                ...(stop ? { stop: 0x1002n } : {}),
              });
              const successor = budget === 2n && !stop;
              outcome(
                result,
                stop ? 'stop' : 'budget',
                budget,
                successor ? 2n : 1n,
                13n,
                0n,
                changed(before, successor ? 0x1003n : 0x1002n),
              );
              noFault(result);
              x87(cpu, afterStore(code, numeric));
              other(cpu);
              memory(cpu, 0x8000n, '7b0390');
              equal(
                result.resources.dispatches,
                successor ? 1 : 0,
                'post-effect dispatch priority',
              );
              equal(result.resources.nativeEntries, successor ? 2 : 1, 'one save entry');
              equal(result.resources.compilations, successor ? 2 : 1, 'refetched successor owner');
              equal(
                result.resources.cachedArtifacts,
                successor ? 1 : 0,
                'completed save retires old source',
              );
            } finally {
              cpu.dispose();
            }
          }
        }
      },
    },
    {
      name: 'FX image geometry precedes alignment which precedes backing admission even with pending x87 state',
      async run() {
        for (const [address, reason, cause] of [
          [0x6001n, 'alignment-fault', ''],
          [0x800000000001n, 'data-fault', 'noncanonical'],
          [(1n << 64n) - 255n, 'data-fault', 'address-range'],
        ] as const) {
          await using(compiler, '0fae03', LONG, async (cpu) => {
            const before = input(0x1000n, { 3: address }, 0xcd7n),
              numeric = stack({ 0: ONE }, 5, 0x37b, 0x8084);
            cpu.setState(before);
            seed(cpu, numeric);
            const result = await cpu.run({ budget: 1n, repeatBudget: 13n });
            outcome(result, reason, 1n, 0n, 13n, 0n, before);
            if (reason === 'alignment-fault') {
              exclusive(result, 'alignmentFault');
              equal(result.alignmentFault?.width, 512, 'FX nominal alignment width');
              equal(result.alignmentFault?.alignment, 16, 'FX alignment');
              equal(result.alignmentFault?.address, address, 'translated FX start');
            } else {
              fault(result, {
                instructionPc: 0x1000n,
                address,
                width: 512,
                access: 'write',
                cause,
                failingAddress: cause === 'address-range' ? 1n << 64n : address,
                segment: 'ds',
              });
              exclusive(result, 'fault');
            }
            x87(cpu, numeric);
            other(cpu);
          });
        }
        const execution = context();
        execution.segments.ds.limit = 0x60ff;
        await using(compiler, '0fae03', execution, async (cpu) => {
          const before = input(0x1000n, { 3: 0x6001n }, 0xcd7n),
            numeric = stack({ 0: ONE }, 5);
          cpu.setState(before);
          seed(cpu, numeric);
          const result = await cpu.run({ budget: 1n, repeatBudget: 13n });
          outcome(result, 'segment-fault', 1n, 0n, 13n, 0n, before);
          exclusive(result, 'segmentFault');
          equal(result.segmentFault?.width, 512, 'FX nominal segment width');
          equal(result.segmentFault?.cause, 'limit', 'segment failure before alignment');
          equal(result.segmentFault?.failingOffset, 0x6100n, 'first invalid segment byte');
          x87(cpu, numeric);
          other(cpu);
        });
      },
    },
    {
      name: 'late FXRSTOR source fault wins over reserved MXCSR and preserves dirty SIMD predecessors through retry',
      async run() {
        const image = new Uint8Array(512).fill(0xa5);
        new DataView(image.buffer).setUint32(24, 0x80000000, true);
        const mappings = [
          map(0x1000n, 'code', 7, true, false, 0, true),
          map(0x6000n, 'image', 511, true, false),
          map(0x8000n, 'image', 512, true, false),
        ];
        const cpu = await createCpu({
          compiler,
          limits: LIMITS,
          entry: 0x1000n,
          memoryLimits: { maxBackings: 2, maxMappings: 3, maxBackingBytes: 1024 },
          memory: {
            backings: [
              { id: 'code', bytes: hex('660fefc00fae0b') },
              { id: 'image', bytes: image },
            ],
            mappings,
          },
        });
        try {
          const before = input(0x1000n, { 3: 0x6000n }, 0xcd7n),
            numeric = stack({ 0: ONE }, 5),
            vector = banks();
          vector[0] = 0n;
          cpu.setState(before);
          seed(cpu, numeric);
          const failed = await cpu.run({ budget: 2n, repeatBudget: 13n });
          outcome(failed, 'data-fault', 2n, 1n, 13n, 0n, changed(before, 0x1004n));
          fault(failed, {
            instructionPc: 0x1004n,
            address: 0x6000n,
            width: 512,
            access: 'read',
            cause: 'unmapped',
            failingAddress: 0x61ffn,
            segment: 'ds',
          });
          exclusive(failed, 'fault');
          x87(cpu, numeric);
          xmm(cpu, vector);
          equal(cpu.readMxcsr(), OTHER_MXCSR, 'source fault preserves MXCSR');
          cpu.setMappings(
            mappings.map((mapping) =>
              mapping.base === 0x6000n ? { ...mapping, length: 512 } : mapping,
            ),
          );
          for (let i = 0; i < 2; i++) {
            const reserved = await cpu.run({ budget: 1n, repeatBudget: 13n });
            outcome(reserved, 'general-protection', 1n, 0n, 13n, 0n, changed(before, 0x1004n));
            exclusive(reserved, 'generalProtectionFault');
            equal(
              reserved.generalProtectionFault?.loadedValue,
              0x80000000,
              'loaded reserved MXCSR',
            );
            equal(reserved.generalProtectionFault?.instructionPc, 0x1004n, 'restore fault PC');
            x87(cpu, numeric);
            xmm(cpu, vector);
            equal(cpu.readMxcsr(), OTHER_MXCSR, 'invalid restore preserves MXCSR');
            if (i === 1)
              equal(reserved.resources.compilations, 0, 'faulting retained restore reuses code');
          }
          memory(cpu, 0x8000n, Array.from(image, (b) => b.toString(16).padStart(2, '0')).join(''));
        } finally {
          cpu.dispose();
        }
      },
    },
  ];
}
