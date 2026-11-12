import {
  usingGate,
  initial,
  complete,
  equal,
  same,
  scalar,
  read,
  put,
  hex,
  gateDescriptor,
  dataDescriptor,
  GDT,
  TSS,
  SOURCE,
  TARGET,
  RAM_SIZE,
  type Scenario,
} from './fixture.js';

const RWX = { read: true, write: true, execute: true };
const R = { read: true, write: false, execute: false };

export function gatePagingScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'call gate prospective CPL1 and CPL2 admit supervisor frame pages with their selected TSS fields',
      async run() {
        for (const targetCpl of [1, 2])
          await usingGate(
            compiler,
            { family: 'legacy32', targetCpl, count: 1, targetCode: 'ca0400' },
            async (cpu) => {
              cpu.setState(initial(SOURCE, { 4: 0x4000n }));
              complete(await cpu.run({ budget: 1n }));
              equal(cpu.readContext().cpl, targetCpl, 'selected inner privilege');
              equal(cpu.readContext().segments.cs.selector, 8 | targetCpl, 'new CS RPL');
              equal(
                cpu.readContext().segments.ss.selector,
                0x10 | targetCpl,
                'selected TSS SS field',
              );
              equal(
                cpu.readState().registers[4],
                0x8fecn,
                'supervisor frame page admitted by prospective CPL',
              );
              complete(await cpu.run({ budget: 1n }));
              equal(cpu.readContext().cpl, 3, 'matching outer return');
            },
          );
      },
    },
    {
      name: 'call gate split physical parameter spans and destination aliases watch translated linear identities only',
      async run() {
        await usingGate(
          compiler,
          {
            family: 'legacy32',
            count: 2,
            newSp: 0x9008n,
            prepare(memory) {
              put(memory, 0x19010, 0xc007n, 4);
              put(memory, 0x19014, 0xe007n, 4);
              put(memory, 0x19020, 0xb023n, 4);
              put(memory, 0x19024, 0x9027n, 4);
              put(memory, 0xcffe, 0x3344n, 2);
              put(memory, 0xe000, 0x1122n, 2);
              put(memory, 0xe002, 0x55667788n, 4);
            },
          },
          async (cpu) => {
            cpu.setDebugState({
              addresses: [0x4fffn, 0xcfffn, 0x8ff0n, 0xbff0n],
              dr6: 0n,
              dr7: 0x11330455n,
            });
            cpu.setState(initial(SOURCE, { 4: 0x4ffen }));
            const result = await cpu.run({ budget: 1n });
            equal(result.reason, 'debug-exception', 'completed selected spans');
            equal(
              result.debugException?.breakpoints,
              5,
              'linear source and destination identities only',
            );
            equal(result.state.registers[4], 0x8ff0n, 'logical destination pointer');
            equal(
              scalar(cpu, 0xbff8n, 4, 'legacy32'),
              0x11223344n,
              'first dword crossed noncontiguous physical pages',
            );
            equal(
              scalar(cpu, 0xbffcn, 4, 'legacy32'),
              0x55667788n,
              'next logical slot followed its own translated page',
            );
            equal(
              scalar(cpu, 0x19020n, 4, 'legacy32') & 0x40n,
              0x40n,
              'actual destination physical translation becomes dirty',
            );
            equal(
              scalar(cpu, 0x9000n, 4, 'legacy32'),
              0x4ffen,
              'saved SP occupies the separate physical frame fragment',
            );
            equal(
              scalar(cpu, 0x9004n, 4, 'legacy32'),
              0x23n,
              'saved SS occupies the separate physical frame fragment',
            );
            equal(
              scalar(cpu, 0x19024n, 4, 'legacy32') & 0x40n,
              0x40n,
              'every committed destination fragment becomes dirty',
            );
          },
        );
      },
    },
    {
      name: 'call gate old-parameter PF handler repairs PTE and IRET retries the uncompleted source exactly once',
      async run() {
        await usingGate(
          compiler,
          {
            family: 'legacy32',
            count: 1,
            targetCode: 'ca0400',
            prepare(memory, context) {
              put(memory, 0x19010, 0n, 4);
              context.idtr = { base: 0xa000n, limit: 0x7ff };
              memory.set(hex('00300800008e0000'), 0xa070);
              memory.set(hex('c705109001002740000083c404cf'), 0x3000);
            },
          },
          async (cpu) => {
            cpu.setState(initial(SOURCE, { 4: 0x4000n }, 0x10202n));
            const fault = await cpu.run({
              budget: 1n,
              stop: 0x3000n,
              eventDelivery: { budget: 1n },
            });
            equal(fault.reason, 'stop', 'automatic PF handler entry');
            equal(fault.retired, 0n, 'failed gate did not retire');
            equal(fault.deliveryAttempts, 1n, 'one PF delivery');
            equal(cpu.readPagingState().cr2, 0x4000n, 'old source parameter fault address');
            equal(fault.state.registers[4], 0x8fe8n, 'only exception frame, no partial gate frame');
            for (const [i, value] of [4n, SOURCE, 0x1bn, 0x10202n, 0x4000n, 0x23n].entries())
              equal(
                scalar(cpu, 0x8fe8n + BigInt(i * 4), 4, 'legacy32'),
                value,
                `literal PF repair frame ${i}`,
              );
            const repaired = await cpu.run({ budget: 3n });
            complete(repaired, 3n);
            equal(repaired.state.rip, SOURCE, 'IRET retries original CALL');
            equal(repaired.state.registers[4], 0x4000n, 'caller stack restored');
            complete(await cpu.run({ budget: 1n }));
            equal(cpu.readState().registers[4], 0x8fecn, 'one successful five-slot gate frame');
            equal(
              scalar(cpu, 0x8ff4n, 4, 'legacy32'),
              0xa100n,
              'retry captures repaired old parameter',
            );
            complete(await cpu.run({ budget: 1n }));
            equal(cpu.readState().rip, 0x1007n, 'matching return completes retry');
            equal(cpu.readState().registers[4], 0x4004n, 'no duplicate copied argument cleanup');
          },
        );
      },
    },
    {
      name: 'call gate post-begin TSS page A alias finishes captured selector and reports its actual private plan failure without replay',
      async run() {
        for (const badSS of [false, true])
          await usingGate(
            compiler,
            {
              family: 'legacy32',
              gateSelector: 0x13,
              entry: 0x1017n,
              code: '9a000000001300',
              prepare(memory, context) {
                memory.copyWithin(0xb000, Number(GDT), Number(GDT) + 0x80);
                context.gdtr.base = 0xb000n;
                put(memory, 0x18000, 0x1027n, 4);
                for (let i = 0; i < RAM_SIZE / 4096; i++)
                  put(
                    memory,
                    0x1000 + i * 4,
                    BigInt(i * 4096) | (i === 6 || i === 7 || i === 8 ? 0x63n : 0x67n),
                    4,
                  );
                put(memory, 0x101c, 0x13n, 4);
                memory.set(hex('9a000000001300'), 0x1017);
                memory.set(dataDescriptor(32, 0), 0xb030);
                put(memory, 4, 0x9000n, 4);
                put(memory, 8, badSS ? 0n : 0x30n, 2);
              },
            },
            async (cpu) => {
              cpu.setState(initial(0x1017n, { 4: 0x4000n }));
              const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
              equal(
                cpu.readPhysicalMemory(0x101cn, 1)[0],
                0x33,
                'selected TSS walk set A in already fetched selector byte',
              );
              if (badSS) {
                equal(
                  result.reason,
                  'protection-fault',
                  'captured original gate reaches invalid new SS',
                );
                equal(result.protectionFault?.vector, 10, 'TS from actual TSS data');
                equal(result.protectionFault?.errorCode, 0, 'not GP from mutated selector33');
                equal(result.state.rip, 0x1017n, 'original instruction remains current');
                equal(result.retired, 0n, 'no failed-plan retirement');
              } else {
                complete(result);
                equal(result.state.rip, TARGET, 'captured gate13 completes');
                equal(result.state.registers[4], 0x8ff0n, 'one complete frame');
                equal(scalar(cpu, 0x8ff0n, 4, 'legacy32'), 0x101en, 'captured next PC');
                equal(
                  cpu.readContext().segments.ss.selector,
                  0x30,
                  'selected TSS field belongs to captured operation',
                );
              }
            },
          );
      },
    },
    {
      name: 'call gate late destination admission retains capture A but publishes no D descriptor A or frame payload',
      async run() {
        await usingGate(
          compiler,
          {
            family: 'legacy32',
            count: 31,
            newSp: 0x9008n,
            codeAccessed: false,
            stackAccessed: false,
            prepare(memory) {
              put(memory, 0x19010, 0x4007n, 4);
              put(memory, 0x19020, 0n, 4);
              put(memory, 0x19024, 0x9027n, 4);
            },
          },
          async (cpu) => {
            const before = read(cpu, 0x9000n, 8, 'legacy32');
            cpu.setState(initial(SOURCE, { 4: 0x4000n }));
            const result = await cpu.run({ budget: 1n });
            equal(result.reason, 'page-fault', 'later parameter-frame slot cannot be admitted');
            equal(
              result.pageFault?.address,
              0x8ffcn,
              'first reversed parameter write after old SS and SP',
            );
            equal(result.pageFault?.errorCode, 2, 'prospective kernel CPL write');
            equal(result.retired, 0n, 'no half gate retirement');
            equal(result.state.registers[4], 0x4000n, 'caller raw stack bank retained');
            equal(
              scalar(cpu, 0x19010n, 4, 'legacy32') & 0x20n,
              0x20n,
              'earlier parameter capture A survives',
            );
            equal(
              scalar(cpu, 0x19024n, 4, 'legacy32') & 0x40n,
              0n,
              'preadmitted first writes did not set D',
            );
            equal(
              read(cpu, GDT + 13n, 1, 'legacy32')[0],
              0x9a,
              'target descriptor A not published',
            );
            equal(
              read(cpu, GDT + 21n, 1, 'legacy32')[0],
              0x92,
              'new SS descriptor A not published',
            );
            same(
              read(cpu, 0x9000n, 8, 'legacy32'),
              before,
              'earlier planned slot payloads unchanged',
            );
          },
        );
      },
    },
    {
      name: 'call gate captures old parameters before overlapping frame writes and descriptor accessed publication',
      async run() {
        await usingGate(compiler, { count: 3, newSp: 0x4008n }, async (cpu) => {
          cpu.setState(initial(SOURCE, { 4: 0x4000n }));
          complete(await cpu.run({ budget: 1n }));
          const expected = [0x1007n, 0x1bn, 0xa100n, 0xa101n, 0xa102n, 0x4000n, 0x23n];
          for (const [i, value] of expected.entries())
            equal(
              scalar(cpu, 0x3fecn + BigInt(i * 4), 4),
              value,
              'captured overlapping frame slot ' + i,
            );
        });
        await usingGate(
          compiler,
          {
            count: 1,
            codeAccessed: false,
            prepare(_memory, context) {
              context.segments.ss.base = 0x200dn;
            },
          },
          async (cpu) => {
            cpu.setState(initial(SOURCE, { 4: 0x4000n }));
            complete(await cpu.run({ budget: 1n }));
            equal(
              scalar(cpu, 0x8ff4n, 4),
              0xff00cf9an,
              'parameter captures original target A0 byte',
            );
            equal(
              cpu.readMemory(GDT + 13n, 1)[0],
              0x9b,
              'descriptor A publishes only after capture',
            );
          },
        );
      },
    },
    {
      name: 'call gate gate and TSS need no write access with accessed target and SS descriptors',
      async run() {
        await usingGate(compiler, { count: 1 }, async (cpu) => {
          const gate = cpu.readMemory(GDT + 0x38n, 8);
          const tss = cpu.readMemory(TSS, 0x100);
          cpu.setMappings([
            { base: 0n, backing: 'ram', offset: 0, length: 0x6000, permissions: RWX },
            { base: GDT, backing: 'ram', offset: 0x6000, length: 0x80, permissions: R },
            { base: 0x6080n, backing: 'ram', offset: 0x6080, length: 0xf80, permissions: RWX },
            { base: TSS, backing: 'ram', offset: 0x7000, length: 0x100, permissions: R },
            {
              base: 0x7100n,
              backing: 'ram',
              offset: 0x7100,
              length: RAM_SIZE - 0x7100,
              permissions: RWX,
            },
          ]);
          cpu.setState(initial(SOURCE, { 4: 0x4000n }));
          complete(await cpu.run({ budget: 1n }));
          same(cpu.readMemory(GDT + 0x38n, 8), gate, 'typeC never gains an ordinary code A bit');
          same(cpu.readMemory(TSS, 0x100), tss, 'no direct TSS or busy update');
        });
      },
    },
    {
      name: 'call gate expanded LDT preserves original widened fff8 index for the 64-bit high half',
      async run() {
        await usingGate(
          compiler,
          {
            mode: 'long64',
            prepare(memory, context) {
              context.ldtr = {
                selector: 0x50,
                valid: true,
                base: 0x10000n,
                limit: 0x10007,
                attributes: 0x82,
              };
              memory.set(gateDescriptor(64).slice(0, 8), 0x1fff8);
              put(memory, 0x5004, 0xffffn, 2);
            },
          },
          async (cpu) => {
            cpu.addBacking({ id: 'tail', bytes: new Uint8Array(8) });
            cpu.setMappings([
              { base: 0n, backing: 'ram', offset: 0, length: RAM_SIZE, permissions: RWX },
              { base: 0x20000n, backing: 'tail', offset: 0, length: 8, permissions: R },
            ]);
            cpu.setState(initial(SOURCE, { 3: 0x5000n, 4: 0x4000n }));
            complete(await cpu.run({ budget: 1n }));
            equal(cpu.readState().rip, TARGET, 'tail above ffff belongs to selected LDT gate');
          },
        );
      },
    },
  ];
}
