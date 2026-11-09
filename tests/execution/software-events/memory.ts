import {
  createCpu,
  using,
  snapshot,
  initial,
  outcome,
  fullState,
  same,
  equal,
  check,
  image,
  encoded,
  hex,
  gate,
  withGate,
  tssDescriptor,
  CODE32,
  LIMITS,
  preserveNumeric,
  type Scenario,
} from './fixture.js';

export function memoryScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'software LTR admits the complete descriptor RMW before changing its busy byte or cached TR',
      async run() {
        for (const wide of [false, true]) {
          const execution = snapshot(wide ? 'long64' : 'protected');
          const descriptor = tssDescriptor(0x5000n, 0x67, 9, wide);
          const size = descriptor.length / 2;
          await using(
            compiler,
            '900f00d890',
            execution,
            async (cpu) => {
              const numeric = preserveNumeric(cpu);
              cpu.setState(initial(0x1000n, { 0: 0x28n }));
              const warm = await cpu.run({ budget: 1n });
              outcome(warm, 'budget', 1n, 1n);
              const owners = cpu.inspectTranslations();
              const failed = await cpu.run({ budget: 1n });
              outcome(failed, 'system-memory-fault', 1n, 0n);
              same(failed.state, warm.state, 'late denied nominal write retains scalar state');
              same(cpu.readContext(), execution, 'failed LTR leaves TR unchanged');
              const fault = failed.systemMemoryFault;
              check(fault?.table === 'gdt', 'descriptor provenance');
              equal(fault.phase, 'descriptor-busy-write', 'RMW admission phase');
              equal(fault.selector, 0x28, 'cached selector candidate');
              equal(fault.access, 'write', 'complete descriptor write admission');
              equal(fault.address, 0x4028n, 'nominal descriptor start');
              equal(fault.width, size, 'complete selected RMW width');
              equal(
                fault.failingAddress,
                0x4028n + BigInt(size - 1),
                'denied tail despite writable busy byte',
              );
              same(cpu.readMemory(0x4028n, size), hex(descriptor), 'no early busy write');
              same(cpu.inspectTranslations(), owners, 'failed admission preserves source identity');
              numeric();
            },
            {
              data: [
                { base: 0x4028n, bytes: descriptor.slice(0, -2) },
                { base: 0x4028n + BigInt(size - 1), bytes: descriptor.slice(-2), write: false },
              ],
            },
          );
        }
      },
    },
    {
      name: 'software event frame is private-atomic across W-only source aliases and commits before destination fetch',
      async run() {
        const execution = snapshot('protected');
        const address = withGate(execution);
        const descriptor = hex('ffff0000009acf00');
        const code = hex('90cd409090');
        const mappings = [
          {
            base: 0x1000n,
            backing: 'code',
            offset: 0,
            length: code.length,
            permissions: { read: true, write: false, execute: true },
          },
          {
            base: 0x4008n,
            backing: 'descriptor',
            offset: 0,
            length: 8,
            permissions: { read: true, write: true, execute: false },
          },
          {
            base: address,
            backing: 'gate',
            offset: 0,
            length: 8,
            permissions: { read: true, write: false, execute: false },
          },
          {
            base: 0x7014n,
            backing: 'code',
            offset: 1,
            length: 4,
            permissions: { read: false, write: true, execute: false },
          },
          {
            base: 0x7018n,
            backing: 'ram',
            offset: 8,
            length: 7,
            permissions: { read: false, write: true, execute: false },
          },
          {
            base: 0x701fn,
            backing: 'ram',
            offset: 15,
            length: 1,
            permissions: { read: true, write: false, execute: false },
          },
          {
            base: 0x9000n,
            backing: 'ram',
            offset: 0,
            length: 32,
            permissions: { read: true, write: false, execute: false },
          },
        ];
        const cpu = await createCpu({
          compiler,
          context: execution,
          entry: 0x1000n,
          limits: LIMITS,
          memoryLimits: { maxBackings: 4, maxMappings: 8, maxBackingBytes: 128 },
          memory: {
            backings: [
              { id: 'code', bytes: code },
              { id: 'descriptor', bytes: descriptor },
              { id: 'gate', bytes: hex(gate(32, 8, 0x2000n, 0)) },
              { id: 'ram', bytes: hex('a5'.repeat(32)) },
            ],
            mappings,
          },
        });
        try {
          const numeric = preserveNumeric(cpu);
          cpu.setState(initial(0x1000n, { 4: 0x7020n }, 0x603n));
          const warm = await cpu.run({ budget: 1n });
          outcome(warm, 'budget', 1n, 1n);
          const owners = cpu.inspectTranslations();
          const failed = await cpu.run({ budget: 1n });
          outcome(failed, 'data-fault', 1n, 0n);
          same(failed.state, warm.state, 'late store denial preserves complete scalar state');
          equal(failed.fault?.address, 0x701cn, 'first architectural FLAGS slot');
          equal(failed.fault?.width, 4, 'complete slot');
          equal(failed.fault?.failingAddress, 0x701fn, 'denied last byte');
          same(cpu.readContext(), execution, 'no partial context');
          same(cpu.readMemory(0x4008n, 8), descriptor, 'no early A write');
          same(cpu.readMemory(0x1000n, code.length), code, 'no early source-alias store');
          same(cpu.readMemory(0x9000n, 32), hex('a5'.repeat(32)), 'no partial frame');
          same(cpu.inspectTranslations(), owners, 'no owner mutation on failed admission');
          cpu.setMappings(
            mappings.map((mapping) =>
              mapping.base === 0x701fn
                ? { ...mapping, permissions: { ...mapping.permissions, write: true } }
                : mapping,
            ),
          );
          const result = await cpu.run({ budget: 1n, stop: 0x2000n });
          outcome(result, 'budget', 1n, 1n);
          fullState(result, warm.state, 0x2000n, 0x7014n, 0x403n);
          equal(
            result.resources.compilations,
            0,
            'retained middle entry used after permission repair',
          );
          same(
            cpu.readMemory(0x1000n, code.length),
            hex('9003100000'),
            'captured next IP overwrites source alias exactly once',
          );
          const ram = hex('a5'.repeat(32));
          ram.set(image([8n, 0x603n], 4), 8);
          same(cpu.readMemory(0x9000n, 32), ram, 'physical frame bytes and guards');
          same(cpu.readMemory(0x4008n, 8), hex(CODE32), 'A byte committed before frame');
          same(cpu.inspectTranslations(), [], 'actual source-alias write invalidates owner');
          const fetch = await cpu.run({ budget: 1n });
          outcome(fetch, 'fetch-fault', 1n, 0n);
          same(fetch.state, result.state, 'later missing handler cannot replay frame');
          same(cpu.readMemory(0x9000n, 32), ram, 'later failure leaves committed frame intact');
          numeric();
        } finally {
          cpu.dispose();
        }
      },
    },
    {
      name: 'software IRETD VM return fails atomically on final GS slot and repairs from its retained entry',
      async run() {
        const execution = snapshot('protected');
        const values = [
          0x1234n,
          0x1000n,
          0x23703n,
          0xabcd7020n,
          0x2000n,
          0x3000n,
          0x4000n,
          0x5000n,
          0x6000n,
        ];
        const frame = encoded(image(values, 4));
        await using(
          compiler,
          '90cf',
          execution,
          async (cpu) => {
            const numeric = preserveNumeric(cpu);
            cpu.setState(initial(0x1000n, { 4: 0x7000n }, 2n));
            const warm = await cpu.run({ budget: 1n });
            const owners = cpu.inspectTranslations();
            const result = await cpu.run({ budget: 1n });
            outcome(result, 'data-fault', 1n, 0n);
            same(result.state, warm.state, 'final-slot failure preserves full state');
            same(cpu.readContext(), execution, 'no partially installed V86 mode or caches');
            equal(result.fault?.address, 0x7020n, 'whole GS source slot');
            equal(result.fault?.width, 4, 'four-byte source slot');
            equal(result.fault?.failingAddress, 0x7023n, 'last GS byte');
            same(cpu.inspectTranslations(), owners, 'failed read retains owner');
            cpu.setMappings([
              {
                base: 0x1000n,
                backing: 'code',
                offset: 0,
                length: 2,
                permissions: { read: true, write: false, execute: true },
              },
              {
                base: 0x7000n,
                backing: 'data0',
                offset: 0,
                length: 35,
                permissions: { read: true, write: false, execute: false },
              },
              {
                base: 0x7023n,
                backing: 'data1',
                offset: 0,
                length: 1,
                permissions: { read: true, write: false, execute: false },
              },
            ]);
            const repaired = await cpu.run({ budget: 1n });
            outcome(repaired, 'budget', 1n, 1n);
            fullState(repaired, warm.state, 0x1234n, 0xabcd7020n, 0x3703n);
            equal(
              cpu.readContext().mode,
              'virtual8086',
              'VM published only after complete admission',
            );
            equal(
              repaired.resources.compilations,
              0,
              'repair enters retained IRET without predecessor',
            );
            same(cpu.readMemory(0x7000n, 36), image(values, 4), 'source bytes never rewritten');
            numeric();
          },
          {
            data: [
              { base: 0x7000n, bytes: frame.slice(0, -2), write: false },
              { base: 0x7023n, bytes: frame.slice(-2), read: false, write: false },
            ],
          },
        );
        const bad = [...values];
        bad[0] = 0x10000n;
        const badFrame = encoded(image(bad, 4));
        await using(
          compiler,
          'cf',
          execution,
          async (cpu) => {
            const numeric = preserveNumeric(cpu);
            const before = initial(0x1000n, { 4: 0x7000n });
            cpu.setState(before);
            const result = await cpu.run({ budget: 1n });
            outcome(result, 'protection-fault', 1n, 0n);
            equal(result.protectionFault?.vector, 13, 'V86 return target exceeds16 bits');
            equal(result.protectionFault?.errorCode, 0, 'target GP0 before extra source slots');
            equal(
              result.fault,
              undefined,
              'denied GS tail is not read after invalid initial target',
            );
            equal(
              result.systemMemoryFault,
              undefined,
              'VM branch does not look up a protected code descriptor',
            );
            same(result.state, before, 'bad VM target publishes no scalar effects');
            same(cpu.readContext(), execution, 'bad VM target publishes no partial context');
            same(
              cpu.readMemory(0x7000n, 35),
              image(bad, 4).slice(0, 35),
              'source prefix unchanged',
            );
            numeric();
          },
          { data: [{ base: 0x7000n, bytes: badFrame.slice(0, -2), write: false }] },
        );
      },
    },
  ];
}
