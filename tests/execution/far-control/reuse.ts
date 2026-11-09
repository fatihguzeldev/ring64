import {
  createCpu,
  using,
  initial,
  snapshot,
  bytes,
  CODE64,
  equal,
  check,
  same,
  hex,
  LIMITS,
  preserveNumeric,
  type Scenario,
} from './fixture.js';
const R = { read: true, write: false, execute: false };
const W = { read: false, write: true, execute: false };
const RW = { read: true, write: true, execute: false };
const RX = { read: true, write: false, execute: true };

export function reuseScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...[false, true].map((stop) => ({
      name: `far new target budget and stop precede unmapped destination fetch ${stop}`,
      async run() {
        await using(
          compiler,
          '48ff2b',
          snapshot(),
          async (cpu) => {
            const numeric = preserveNumeric(cpu);
            const rawSp = 0x800000000000n;
            cpu.setState(initial(0x1000n, { 3: 0x6000n, 4: rawSp }, 0xcd7n));
            const result = await cpu.run({
              budget: stop ? 2n : 1n,
              ...(stop ? { stop: 0x2000n } : {}),
            });
            equal(result.reason, stop ? 'stop' : 'budget', 'new target gate');
            equal(result.retired, 1n, 'transfer retired once');
            equal(result.state.rip, 0x2000n, 'new logical target');
            equal(result.state.registers[4], rawSp, 'JMP never admits stack');
            equal(result.fault, undefined, 'no eager target fetch');
            const fetched = await cpu.run({ budget: 1n });
            equal(fetched.reason, 'fetch-fault', 'later destination fetch');
            equal(fetched.retired, 0n, 'no replay');
            equal(fetched.fault?.segment, 'cs', 'target CS');
            equal(fetched.fault?.instructionPc, 0x2000n, 'target fault PC');
            equal(fetched.fault?.address, 0x2000n, 'target mapping');
            numeric();
          },
          {
            data: [
              { base: 0x4008n, bytes: CODE64, write: false },
              { base: 0x6000n, bytes: bytes(0x2000n, 8) + '0800', write: false },
            ],
          },
        );
      },
    })),
    ...[false, true].map((aliasSlots) => ({
      name: `far CALL writes full write-only CS slots in push order alias ${aliasSlots}`,
      async run() {
        const backing = hex('a1a2a3a4a5a6a7a8');
        const cpu = await createCpu({
          compiler,
          context: snapshot(),
          entry: 0x1000n,
          limits: LIMITS,
          memoryLimits: { maxBackings: 4, maxMappings: 6, maxBackingBytes: 64 },
          memory: {
            backings: [
              { id: 'code', bytes: hex('ff1b') },
              { id: 'gdt', bytes: hex(CODE64) },
              { id: 'pointer', bytes: hex(bytes(0x2000n, 4) + '0800') },
              { id: 'stack', bytes: backing },
            ],
            mappings: [
              { base: 0x1000n, backing: 'code', offset: 0, length: 2, permissions: RX },
              { base: 0x4008n, backing: 'gdt', offset: 0, length: 8, permissions: R },
              { base: 0x6000n, backing: 'pointer', offset: 0, length: 6, permissions: R },
              ...(aliasSlots
                ? [
                    { base: 0x7000n, backing: 'stack', offset: 0, length: 4, permissions: W },
                    { base: 0x7004n, backing: 'stack', offset: 0, length: 4, permissions: W },
                    { base: 0x8000n, backing: 'stack', offset: 0, length: 8, permissions: R },
                  ]
                : [
                    { base: 0x7000n, backing: 'stack', offset: 0, length: 8, permissions: W },
                    { base: 0x8000n, backing: 'stack', offset: 0, length: 8, permissions: R },
                  ]),
            ],
          },
        });
        try {
          const numeric = preserveNumeric(cpu);
          cpu.setState(initial(0x1000n, { 3: 0x6000n, 4: 0x7008n }));
          const result = await cpu.run({ budget: 1n });
          equal(result.reason, 'budget', 'write-only frame');
          equal(result.state.rip, 0x2000n, 'new PC');
          equal(result.state.registers[4], 0x7000n, 'two32bit slots');
          same(
            cpu.readMemory(0x8000n, 8),
            hex(aliasSlots ? '02100000a5a6a7a8' : '0210000008000000'),
            'CS first and IP last with zero padding',
          );
          numeric();
        } finally {
          cpu.dispose();
        }
      },
    })),
    {
      name: 'far frame can overwrite a just-set A byte while installed CS remains captured',
      async run() {
        const cpu = await createCpu({
          compiler,
          context: snapshot(),
          entry: 0x1000n,
          limits: LIMITS,
          memoryLimits: { maxBackings: 4, maxMappings: 6, maxBackingBytes: 64 },
          memory: {
            backings: [
              { id: 'code', bytes: hex('ff1b') },
              { id: 'gdt', bytes: hex('ffff0000009aaf00ee') },
              { id: 'pointer', bytes: hex(bytes(0x2000n, 4) + '0800') },
              { id: 'ip', bytes: hex('aabbccdd') },
            ],
            mappings: [
              { base: 0x1000n, backing: 'code', offset: 0, length: 2, permissions: RX },
              { base: 0x4008n, backing: 'gdt', offset: 0, length: 8, permissions: RW },
              { base: 0x6000n, backing: 'pointer', offset: 0, length: 6, permissions: R },
              { base: 0x7000n, backing: 'ip', offset: 0, length: 4, permissions: RW },
              { base: 0x7004n, backing: 'gdt', offset: 5, length: 4, permissions: RW },
            ],
          },
        });
        try {
          cpu.setState(initial(0x1000n, { 3: 0x6000n, 4: 0x7008n }));
          const result = await cpu.run({ budget: 1n });
          equal(result.reason, 'budget', 'captured descriptor transfer');
          equal(cpu.readMemory(0x400dn, 1)[0], 8, 'frame overwrote A');
          const cs = cpu.readContext().segments.cs;
          equal(cs.selector, 8, 'loaded selector');
          check(cs.accessed && cs.present && cs.long, 'captured attributes');
          equal(cs.limit, 0xffffffff, 'captured limit');
          equal(cs.default32, false, 'captured size');
        } finally {
          cpu.dispose();
        }
      },
    },
    {
      name: 'far CS replacement and A byte executable alias complete one redispatch',
      async run() {
        const execution = snapshot('protected');
        execution.segments.cs.selector = 0x18;
        const cpu = await createCpu({
          compiler,
          context: execution,
          entry: 0x1000n,
          limits: LIMITS,
          memoryLimits: { maxBackings: 3, maxMappings: 4, maxBackingBytes: 32 },
          memory: {
            backings: [
              { id: 'shared', bytes: hex('ffff0000009acf0000000800') },
              { id: 'stack', bytes: new Uint8Array(8) },
              { id: 'target', bytes: hex('90') },
            ],
            mappings: [
              { base: 0x1000n, backing: 'shared', offset: 5, length: 7, permissions: RX },
              { base: 0x4008n, backing: 'shared', offset: 0, length: 8, permissions: RW },
              { base: 0x7000n, backing: 'stack', offset: 0, length: 8, permissions: RW },
              { base: 0xcfn, backing: 'target', offset: 0, length: 1, permissions: RX },
            ],
          },
        });
        try {
          const numeric = preserveNumeric(cpu);
          cpu.setState(initial(0x1000n, { 4: 0x7008n }, 0xcd7n));
          const result = await cpu.run({ budget: 2n });
          equal(result.reason, 'budget', 'target successor');
          equal(result.retired, 2n, 'CALL and NOP once');
          equal(result.state.rip, 0xd0n, 'new CS target then successor');
          equal(result.resources.dispatches, 1, 'aggregate dispatch');
          equal(result.resources.nativeEntries, 2, 'old then new assumptions');
          equal(cpu.readMemory(0x1000n, 1)[0], 0x9b, 'executed opcode alias changed');
          same(
            cpu.readMemory(0x7000n, 8),
            hex('0710000018000000'),
            'captured old selector and source next-PC',
          );
          equal(cpu.readContext().segments.cs.selector, 8, 'new CS');
          check(
            !cpu.inspectTranslations().some((unit) => unit.entries.includes(0x1000n)),
            'old alias owner gone',
          );
          numeric();
        } finally {
          cpu.dispose();
        }
      },
    },
  ];
}
