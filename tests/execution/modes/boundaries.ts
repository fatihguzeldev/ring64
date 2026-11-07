import { createCpu, type RunResult, type SegmentFault } from '../../../host/index.js';
import { LIMITS, check, equal, exit, fault, hex, memory, state } from '../../support/fixture.js';
import { changed, context, input, using, type Scenario } from './fixture.js';

function segmentFault(result: RunResult, expected: SegmentFault): void {
  equal(result.fault, undefined, 'exclusive segment diagnostic');
  check(result.segmentFault, 'missing segment failure metadata');
  for (const key of [
    'instructionPc',
    'segment',
    'offset',
    'width',
    'access',
    'cause',
    'failingOffset',
  ] as const)
    equal(result.segmentFault[key], expected[key], `segment fault ${key}`);
}

export function boundaryScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'segment usability and type precede bounds and mapping checks',
      async run() {
        for (const row of [
          { code: '8b03', type: 'code', usable: false, access: 'read', cause: 'unusable' },
          { code: '8903', type: 'read-only', usable: true, access: 'write', cause: 'type' },
          { code: 'd323', type: 'code', usable: true, access: 'write', cause: 'type' },
          { code: '0f4403', type: 'code', usable: true, access: 'read', cause: 'type' },
        ] as const) {
          const ctx = context();
          Object.assign(ctx.segments.ds, { type: row.type, usable: row.usable, limit: 0 });
          await using(compiler, row.code, ctx, async (cpu) => {
            const before = input(0x1000n, { 1: 0n, 3: 0x2000n }, 2n);
            cpu.setState(before);
            const result = await cpu.run({ budget: 1n });
            exit(result, 'segment-fault', 1n, 0n, before);
            segmentFault(result, {
              instructionPc: 0x1000n,
              segment: 'ds',
              offset: 0x2000n,
              width: 4,
              access: row.access,
              cause: row.cause,
              failingOffset: 0x2000n,
            });
            memory(cpu, 0x1000n, row.code);
          });
        }
      },
    },
    {
      name: 'repairing a segment fault resumes without rewriting raw state or reviving old owners',
      async run() {
        const broken = context();
        broken.segments.ds.base = 0x10000n;
        broken.segments.ds.usable = false;
        await using(
          compiler,
          '8b03',
          broken,
          async (cpu) => {
            const before = input(0x1000n, { 3: 0x2000n });
            cpu.setState(before);
            const failed = await cpu.run({ budget: 1n });
            exit(failed, 'segment-fault', 1n, 0n, before);
            segmentFault(failed, {
              instructionPc: 0x1000n,
              segment: 'ds',
              offset: 0x2000n,
              width: 4,
              access: 'read',
              cause: 'unusable',
              failingOffset: 0x2000n,
            });
            const faultOwner = cpu.inspectTranslations()[0]!.owner;
            cpu.setContext(broken);
            equal(
              cpu.inspectTranslations()[0]!.owner,
              faultOwner,
              'equal context retains faulting owner',
            );
            const repaired = context();
            repaired.segments.ds.base = 0x10000n;
            cpu.setContext(repaired);
            state(cpu.readState(), before);
            equal(cpu.inspectTranslations().length, 0, 'repair retires faulting owner');
            const resumed = await cpu.run({ budget: 1n });
            const after = changed(before, 0x1002n, { 0: 0x1122334412345678n });
            exit(resumed, 'budget', 1n, 1n, after);
            equal(resumed.fault, undefined, 'repaired linear diagnostic cleared');
            equal(resumed.segmentFault, undefined, 'repaired segment diagnostic cleared');
            const repairedOwner = cpu.inspectTranslations()[0]!.owner;
            check(repairedOwner !== faultOwner, 'repair uses a fresh owner token');
            cpu.setContext(repaired);
            equal(cpu.inspectTranslations()[0]!.owner, repairedOwner, 'equal repair retains owner');
            cpu.setState(before);
            const reused = await cpu.run({ budget: 1n });
            exit(reused, 'budget', 1n, 1n, after);
            equal(reused.resources.compilations, 0, 'same context reuses warm code');
            const other = context();
            other.segments.ds.base = 0x20000n;
            cpu.setContext(other);
            cpu.setContext(repaired);
            state(cpu.readState(), after);
            equal(
              cpu.inspectTranslations().length,
              0,
              'context round trip cannot revive retired owner',
            );
            cpu.setState(before);
            const rebuilt = await cpu.run({ budget: 1n });
            exit(rebuilt, 'budget', 1n, 1n, after);
            equal(rebuilt.resources.compilations, 1, 'context round trip recompiles');
            check(
              cpu.inspectTranslations()[0]!.owner !== repairedOwner,
              'context round trip uses a fresh token',
            );
            memory(cpu, 0x1000n, '8b03');
            memory(cpu, 0x11fffn, 'a578563412a5');
          },
          { data: [{ base: 0x11fffn, bytes: 'a578563412a5' }] },
        );
      },
    },
    {
      name: 'expand-down accesses check the full span and admit empty imported ranges',
      async run() {
        for (const row of [
          { limit: 0xff00, offset: 0xfffcn, failing: undefined },
          { limit: 0xff00, offset: 0xfffen, failing: 0x10000n },
          { limit: 0xffff, offset: 0xfffcn, failing: 0xfffcn },
        ]) {
          const ctx = context();
          Object.assign(ctx.segments.ds, {
            type: 'expand-down-read-write',
            base: 0x10000n,
            limit: row.limit,
            default32: false,
          });
          await using(
            compiler,
            '8b03',
            ctx,
            async (cpu) => {
              const before = input(0x1000n, { 3: row.offset });
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              if (row.failing === undefined)
                exit(
                  result,
                  'budget',
                  1n,
                  1n,
                  changed(before, 0x1002n, { 0: 0x1122334412345678n }),
                );
              else {
                exit(result, 'segment-fault', 1n, 0n, before);
                segmentFault(result, {
                  instructionPc: 0x1000n,
                  segment: 'ds',
                  offset: row.offset,
                  width: 4,
                  access: 'read',
                  cause: 'limit',
                  failingOffset: row.failing,
                });
              }
              memory(cpu, 0x1fffcn, '78563412a5a5');
            },
            { data: [{ base: 0x1fffcn, bytes: '78563412a5a5' }] },
          );
        }
      },
    },
    {
      name: 'SP16 wraps independently of a full four-byte stack slot',
      async run() {
        for (const push of [false, true])
          for (const limit of [0xffffffff, 0xffff]) {
            const ctx = context('protected', true, false);
            ctx.segments.ss.base = 0x20000n;
            ctx.segments.ss.limit = limit;
            await using(
              compiler,
              push ? '54' : '58',
              ctx,
              async (cpu) => {
                const before = input(0x1000n, {
                  4: push ? 0x1122334400010003n : 0x112233440001ffffn,
                });
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n });
                if (limit === 0xffff) {
                  exit(result, 'segment-fault', 1n, 0n, before);
                  segmentFault(result, {
                    instructionPc: 0x1000n,
                    segment: 'ss',
                    offset: 0xffffn,
                    width: 4,
                    access: push ? 'write' : 'read',
                    cause: 'limit',
                    failingOffset: 0x10000n,
                  });
                } else
                  exit(
                    result,
                    'budget',
                    1n,
                    1n,
                    changed(
                      before,
                      0x1001n,
                      push
                        ? { 4: 0x112233440001ffffn }
                        : { 0: 0x1122334412345678n, 4: 0x1122334400010003n },
                    ),
                  );
                memory(
                  cpu,
                  0x2ffffn,
                  push && limit !== 0xffff ? '03000100' : push ? 'a5a5a5a5' : '78563412',
                );
              },
              { data: [{ base: 0x2ffffn, bytes: push ? 'a5a5a5a5' : '78563412' }] },
            );
          }
      },
    },
    {
      name: 'POP pointer aliases merge after incrementing the selected stack view',
      async run() {
        for (const row of [
          { code: '665c', stack32: true, data: 'efbe', after: 0x112233440001beefn },
          { code: '5c', stack32: false, data: 'efbeadde', after: 0x11223344deadbeefn },
        ]) {
          const ctx = context('protected', true, row.stack32);
          ctx.segments.ss.base = 0x20000n;
          await using(
            compiler,
            row.code,
            ctx,
            async (cpu) => {
              const before = input(0x1000n, { 4: 0x112233440000ffffn });
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              exit(
                result,
                'budget',
                1n,
                1n,
                changed(before, 0x1000n + BigInt(row.code.length / 2), { 4: row.after }),
              );
              equal(result.fault, undefined, 'no linear fault');
              equal(result.segmentFault, undefined, 'no segment fault');
              memory(cpu, 0x2ffffn, row.data);
            },
            { data: [{ base: 0x2ffffn, bytes: row.data }] },
          );
        }
      },
    },
    {
      name: 'reached long64 faults retain actual base-register segment provenance',
      async run() {
        for (const row of [
          { code: '8b4500', segment: 'ss', address: 0x2000n },
          { code: '8b0424', segment: 'ss', address: 0x2000n },
          { code: '418b4500', segment: 'ds', address: 0x2000n },
          { code: '418b0424', segment: 'ds', address: 0x2000n },
          { code: '678b4500', segment: 'ss', address: 0x2000n },
          { code: '67418b4500', segment: 'ds', address: 0x2000n },
          { code: '8b042d00100000', segment: 'ds', address: 0x3000n },
          { code: '368b00', segment: 'ds', address: 0x2000n },
          { code: '3e8b4500', segment: 'ss', address: 0x2000n },
          { code: '648b4500', segment: 'fs', address: 0x12000n },
        ] as const)
          await using(
            compiler,
            row.code,
            { mode: 'long64', fsBase: 0x10000n, gsBase: 0n },
            async (cpu) => {
              const before = input(0x1000n, {
                0: 0x2000n,
                4: 0x2000n,
                5: 0x2000n,
                12: 0x2000n,
                13: 0x2000n,
              });
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              exit(result, 'data-fault', 1n, 0n, before);
              fault(result, {
                instructionPc: 0x1000n,
                segment: row.segment,
                address: row.address,
                width: 4,
                access: 'read',
                cause: 'unmapped',
                failingAddress: row.address,
              });
              memory(cpu, 0x1000n, row.code);
            },
          );
      },
    },
    {
      name: 'CALL checks its target before SS while RET reads SS before its target',
      async run() {
        for (const row of [
          { code: '64e8fa000000', stack: undefined, call: true },
          { code: '64c3', stack: undefined, call: false },
          { code: '64c3', stack: '00110000', call: false },
        ]) {
          const ctx = context();
          ctx.segments.cs.limit = 0x10ff;
          ctx.segments.fs.usable = false;
          await using(
            compiler,
            row.code,
            ctx,
            async (cpu) => {
              const before = input(0x1000n, { 4: 0x4000n });
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              if (row.call || row.stack !== undefined) {
                exit(result, 'segment-fault', 1n, 0n, before);
                segmentFault(result, {
                  instructionPc: 0x1000n,
                  segment: 'cs',
                  offset: 0x1100n,
                  width: 1,
                  access: 'execute',
                  cause: 'limit',
                  failingOffset: 0x1100n,
                });
              } else {
                exit(result, 'data-fault', 1n, 0n, before);
                fault(result, {
                  instructionPc: 0x1000n,
                  segment: 'ss',
                  address: 0x4000n,
                  width: 4,
                  access: 'read',
                  cause: 'unmapped',
                  failingAddress: 0x4000n,
                });
              }
              memory(cpu, 0x1000n, row.code);
              if (row.stack) memory(cpu, 0x4000n, row.stack);
            },
            { data: row.stack ? [{ base: 0x4000n, bytes: row.stack }] : [] },
          );
        }
      },
    },
    {
      name: 'nonzero CS source owners follow host and guest writes through a linear alias',
      async run() {
        const ctx = context();
        ctx.segments.cs.base = 0x20000n;
        ctx.segments.ds.base = 0x30000n;
        await using(
          compiler,
          'c603bbb801000000',
          ctx,
          async (cpu) => {
            cpu.setMappings([
              {
                base: 0x21000n,
                backing: 'code',
                offset: 0,
                length: 8,
                permissions: { read: true, write: false, execute: true },
              },
              {
                base: 0x31000n,
                backing: 'code',
                offset: 0,
                length: 8,
                permissions: { read: true, write: true, execute: false },
              },
            ]);
            const target = input(0x1003n);
            cpu.setState(target);
            exit(
              await cpu.run({ budget: 1n }),
              'budget',
              1n,
              1n,
              changed(target, 0x1008n, { 0: 0x1122334400000001n }),
            );
            const owner = cpu.inspectTranslations()[0]!;
            check(owner.entries.includes(0x1003n), 'logical retained entry');
            check(
              owner.dependencies.some((range) => range.start === 0x21003n),
              'translated source range',
            );
            cpu.writeMemory(0x31004n, Uint8Array.of(9));
            equal(cpu.inspectTranslations().length, 0, 'host alias patch retires logical owner');
            cpu.setState(target);
            const patched = await cpu.run({ budget: 1n });
            exit(patched, 'budget', 1n, 1n, changed(target, 0x1008n, { 0: 0x1122334400000009n }));
            equal(patched.resources.compilations, 1, 'patched target recompiles');
            const writer = input(0x1000n, { 3: 0x1122334400001003n });
            cpu.setState(writer);
            const result = await cpu.run({ budget: 2n });
            exit(result, 'budget', 2n, 2n, changed(writer, 0x1008n, { 3: 0x1122334400000009n }));
            equal(
              result.resources.dispatches,
              1,
              'active source patch dispatches after retirement',
            );
            check(
              !cpu.inspectTranslations().some((unit) => unit.entries.includes(0x1000n)),
              'stale writer owner removed',
            );
            memory(cpu, 0x21000n, 'c603bbbb09000000');
            memory(cpu, 0x31000n, 'c603bbbb09000000');
          },
          { codeBase: 0x21000n },
        );
      },
    },
    {
      name: 'EIP completion wraps while required bytes and reached raw RIP stay in the offset domain',
      async run() {
        for (const code of ['f5', '66'])
          await using(
            compiler,
            code,
            context(),
            async (cpu) => {
              const before = input(0xffffffffn);
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              if (code === 'f5') {
                exit(result, 'budget', 1n, 1n, changed(before, 0n, {}, 0x8d6n));
                cpu.setState(before);
                exit(await cpu.run({ budget: 2n }), 'budget', 2n, 2n, changed(before, 1n));
              } else {
                exit(result, 'segment-fault', 1n, 0n, before);
                segmentFault(result, {
                  instructionPc: 0xffffffffn,
                  segment: 'cs',
                  offset: 0x100000000n,
                  width: 1,
                  access: 'execute',
                  cause: 'limit',
                  failingOffset: 0x100000000n,
                });
              }
              const raw = input(0x100000000n);
              cpu.setState(raw);
              exit(await cpu.run({ budget: 0n }), 'budget', 0n, 0n, raw);
              exit(await cpu.run({ budget: 1n, stop: raw.rip }), 'stop', 1n, 0n, raw);
              const reached = await cpu.run({ budget: 1n });
              exit(reached, 'segment-fault', 1n, 0n, raw);
              segmentFault(reached, {
                instructionPc: raw.rip,
                segment: 'cs',
                offset: raw.rip,
                width: 1,
                access: 'execute',
                cause: 'limit',
                failingOffset: raw.rip,
              });
              memory(cpu, 0xffffffffn, code);
              memory(cpu, 0n, 'f5');
            },
            { entry: 0xffffffffn, data: [{ base: 0n, bytes: 'f5', execute: true }] },
          );
      },
    },
    {
      name: 'required code bytes translate separately across the linear32 boundary',
      async run() {
        const ctx = context();
        ctx.segments.cs.base = 0xffffe000n;
        const cpu = await createCpu({
          compiler,
          context: ctx,
          entry: 0x1ffen,
          memory: {
            backings: [{ id: 'code', bytes: hex('b878563412') }],
            mappings: [
              {
                base: 0xfffffffen,
                backing: 'code',
                offset: 0,
                length: 2,
                permissions: { read: true, write: false, execute: true },
              },
              {
                base: 0n,
                backing: 'code',
                offset: 2,
                length: 3,
                permissions: { read: true, write: false, execute: true },
              },
              {
                base: 0x4000n,
                backing: 'code',
                offset: 0,
                length: 5,
                permissions: { read: true, write: true, execute: false },
              },
            ],
          },
          memoryLimits: { maxBackings: 1, maxMappings: 3, maxBackingBytes: 5 },
          limits: { ...LIMITS, maxInstructions: 1, maxSourceBytes: 5 },
        });
        try {
          const before = input(0x1ffen);
          cpu.setState(before);
          const result = await cpu.run({ budget: 1n });
          exit(result, 'budget', 1n, 1n, changed(before, 0x2003n, { 0: 0x1122334412345678n }));
          const ranges = cpu.inspectTranslations()[0]!.dependencies;
          check(
            ranges.some((range) => range.start === 0n),
            'wrapped low source range',
          );
          check(
            ranges.some((range) => range.start === 0xfffffffen),
            'high source range',
          );
          cpu.writeMemory(0x4001n, Uint8Array.of(9));
          equal(cpu.inspectTranslations().length, 0, 'wrapped-source alias patch retires owner');
          cpu.setState(before);
          exit(
            await cpu.run({ budget: 1n }),
            'budget',
            1n,
            1n,
            changed(before, 0x2003n, { 0: 0x1122334412345609n }),
          );
          memory(cpu, 0x4000n, 'b809563412');
        } finally {
          cpu.dispose();
        }
      },
    },
  ];
}
