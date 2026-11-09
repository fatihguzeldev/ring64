import {
  createCpu,
  snapshot,
  initial,
  outcome,
  same,
  equal,
  hex,
  image,
  gate,
  withGate,
  CODE32,
  LIMITS,
  preserveNumeric,
  type Scenario,
} from './fixture.js';

export function aliasScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'software entry captures aliased gate fields and dirty live scalar FLAGS XMM before ordered frame writes',
      async run() {
        const execution = snapshot('protected');
        const address = withGate(execution);
        const code = hex('40ba00000000fd0f28c1cd40');
        const cpu = await createCpu({
          compiler,
          context: execution,
          entry: 0x1000n,
          limits: LIMITS,
          memoryLimits: { maxBackings: 4, maxMappings: 8, maxBackingBytes: 128 },
          memory: {
            backings: [
              { id: 'code', bytes: code },
              { id: 'descriptor', bytes: hex(CODE32) },
              { id: 'gate', bytes: hex(gate(32, 8, 0x2000n, 0)) },
              { id: 'ram', bytes: hex('a5'.repeat(32)) },
            ],
            mappings: [
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
                permissions: { read: true, write: false, execute: false },
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
                backing: 'ram',
                offset: 4,
                length: 4,
                permissions: { read: false, write: true, execute: false },
              },
              {
                base: 0x7018n,
                backing: 'gate',
                offset: 4,
                length: 4,
                permissions: { read: false, write: true, execute: false },
              },
              {
                base: 0x701cn,
                backing: 'gate',
                offset: 0,
                length: 4,
                permissions: { read: false, write: true, execute: false },
              },
              {
                base: 0x9000n,
                backing: 'ram',
                offset: 0,
                length: 32,
                permissions: { read: true, write: false, execute: false },
              },
            ],
          },
        });
        try {
          preserveNumeric(cpu);
          const xmm = cpu.readXmmState();
          const x87 = cpu.readX87State();
          const mxcsr = cpu.readMxcsr();
          const before = initial(0x1000n, { 0: 0x7fffffffn, 4: 0x7020n }, 0x202n);
          cpu.setState(before);
          const result = await cpu.run({ budget: 5n, repeatBudget: 37n, stop: 0x2000n });
          outcome(result, 'budget', 5n, 5n, 37n);
          const expected = {
            ...before,
            registers: before.registers.map((value, index) =>
              index === 0
                ? 0x80000000n
                : index === 2
                  ? value & 0xffffffff00000000n
                  : index === 4
                    ? 0x7014n
                    : value,
            ),
            rip: 0x2000n,
            flags: 0xc96n,
          };
          same(
            result.state,
            expected,
            'dirty EAX EDX DF arithmetic and system flags reach the event boundary',
          );
          same(cpu.readContext(), execution, 'captured selector survives gate being overwritten');
          same(
            cpu.readXmmState(),
            xmm.map((value, index) => (index === 0 ? xmm[1]! : value)),
            'dirty live XMM survives helper and exit',
          );
          same(cpu.readX87State(), x87, 'pending x87 unchanged');
          equal(cpu.readMxcsr(), mxcsr, 'MXCSR unchanged');
          same(
            cpu.readMemory(address, 8),
            hex('960e000008000000'),
            'FLAGS then CS alias writes use captured gate fields',
          );
          const ram = hex('a5'.repeat(32));
          ram.set(image([0x100cn], 4), 4);
          same(cpu.readMemory(0x9000n, 32), ram, 'captured next PC and all backing guards');
          same(
            cpu.readMemory(0x1000n, code.length),
            code,
            'gate alias writes do not touch code backing',
          );
          const retry = { ...expected, rip: 0x100an, flags: 0xe96n };
          cpu.setState(retry);
          const failed = await cpu.run({ budget: 1n });
          outcome(failed, 'protection-fault', 1n, 0n);
          equal(failed.protectionFault?.vector, 13, 'next entry rereads changed gate');
          equal(failed.protectionFault?.errorCode, 0x202, 'live IDT fault');
          same(failed.state, retry, 'failed retained entry keeps all completed predecessors');
          equal(failed.resources.compilations, 0, 'middle entry reuses unaffected source owner');
          same(
            cpu.readMemory(address, 8),
            hex('960e000008000000'),
            'failed subsequent entry performs no replayed frame stores',
          );
          same(cpu.readMemory(0x9000n, 32), ram, 'old frame remains unchanged');
          same(
            cpu.readXmmState(),
            xmm.map((value, index) => (index === 0 ? xmm[1]! : value)),
            'fault preserves latest XMM projection',
          );
          same(cpu.readX87State(), x87, 'fault preserves pending x87');
        } finally {
          cpu.dispose();
        }
      },
    },
  ];
}
