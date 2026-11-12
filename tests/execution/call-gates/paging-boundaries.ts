import { createCpu } from '../../../host/index.js';
import {
  usingGate,
  fixtureOptions,
  initial,
  complete,
  equal,
  check,
  same,
  scalar,
  put,
  hex,
  little,
  preserveNumeric,
  SOURCE,
  TARGET,
  RAM_SIZE,
  type Family,
  type Scenario,
} from './fixture.js';

const RWX = { read: true, write: true, execute: true };
const XD = 1n << 63n;
const families = ['legacy32', 'pae', 'ia32e', 'fixed-ia32e'] as const;
const longFamily = (family: Family) => family === 'ia32e' || family === 'fixed-ia32e';
const leaf = (family: Family, page: number) =>
  (longFamily(family) ? 0x17000 : 0x19000) + page * (family === 'legacy32' ? 4 : 8);
const entryBytes = (family: Family) => (family === 'legacy32' ? 4 : 8);

export function gatePagingBoundaryScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'call gate prospective supervisor frame respects WP0 and WP1 on read-only supervisor leaves in every paged family',
      async run() {
        for (const family of families)
          for (const wp of [false, true])
            await usingGate(
              compiler,
              {
                family,
                mode: longFamily(family) ? 'long64' : 'protected',
                count: 1,
                prepare(memory) {
                  put(memory, leaf(family, 8), 0x8061n, entryBytes(family));
                },
              },
              async (cpu) => {
                const numeric = preserveNumeric(cpu);
                const bank = cpu.readPagingState();
                cpu.setPagingState({ ...bank, cr0: bank.cr0 | (wp ? 0x10000n : 0n) });
                const before = initial(SOURCE, { 3: 0x5000n, 4: 0x4000n }, 0x10002n);
                cpu.setState(before);
                const context = cpu.readContext();
                const ram = cpu.readPhysicalMemory(0n, RAM_SIZE);
                const result = await cpu.run({ budget: 1n });
                if (wp) {
                  equal(result.reason, 'page-fault', 'WP1 refuses destination supervisor write');
                  equal(
                    result.pageFault?.address,
                    longFamily(family) ? 0x8ff8n : 0x8ffcn,
                    'first actual frame slot',
                  );
                  equal(
                    result.pageFault?.errorCode,
                    3,
                    'present supervisor write uses prospective CPL0',
                  );
                  equal(result.retired, 0n, 'no refused gate retirement');
                  same(
                    result.state.registers,
                    before.registers,
                    'no destination pointer publication',
                  );
                  same(cpu.readContext(), context, 'no partial loaded context');
                  same(
                    cpu.readPhysicalMemory(0n, RAM_SIZE),
                    ram,
                    'no frame descriptor or D publication',
                  );
                } else {
                  complete(result);
                  equal(result.state.rip, TARGET, 'WP0 entered selected gate target');
                  equal(cpu.readContext().cpl, 0, 'destination privilege admitted the write');
                  const width = longFamily(family) ? 8 : 4;
                  const values = longFamily(family)
                    ? [0x1002n, 0x1bn, 0x4000n, 0x23n]
                    : [0x1007n, 0x1bn, 0xa100n, 0x4000n, 0x23n];
                  const sp = 0x9000n - BigInt(values.length * width);
                  equal(result.state.registers[4], sp, 'complete frame geometry');
                  for (const [index, value] of values.entries())
                    equal(
                      scalar(cpu, sp + BigInt(index * width), width, family),
                      value,
                      'literal WP0 frame slot',
                    );
                }
                equal(result.state.flags, 2n, 'only begun-instruction RF clear');
                numeric();
              },
            );
      },
    },
    {
      name: 'call gate old parameter reads retain user permission under both WP settings while gate and TSS metadata stay supervisor',
      async run() {
        for (const family of ['legacy32', 'pae'] as const)
          for (const wp of [false, true])
            await usingGate(
              compiler,
              {
                family,
                count: 1,
                prepare(memory) {
                  put(memory, leaf(family, 4), 0x4063n, entryBytes(family));
                },
              },
              async (cpu) => {
                const numeric = preserveNumeric(cpu);
                const bank = cpu.readPagingState();
                cpu.setPagingState({ ...bank, cr0: bank.cr0 | (wp ? 0x10000n : 0n) });
                const before = initial(SOURCE, { 4: 0x4000n });
                cpu.setState(before);
                const context = cpu.readContext();
                const ram = cpu.readPhysicalMemory(0n, RAM_SIZE);
                const result = await cpu.run({ budget: 1n });
                equal(
                  result.reason,
                  'page-fault',
                  'old user parameter cannot borrow supervisor privilege',
                );
                equal(
                  result.pageFault?.address,
                  0x4000n,
                  'metadata completed before old parameter',
                );
                equal(result.pageFault?.errorCode, 5, 'present read retains original U1');
                equal(result.systemMemoryFault, undefined, 'not gate or TSS traffic');
                equal(result.retired, 0n, 'failed parameter retires nothing');
                same(result.state.registers, before.registers, 'caller raw banks retained');
                same(cpu.readContext(), context, 'no partial privilege switch');
                same(
                  cpu.readPhysicalMemory(0n, RAM_SIZE),
                  ram,
                  'no parameter frame or descriptor publication',
                );
                numeric();
              },
            );
      },
    },
    {
      name: 'call gate target XD and nonpresent fetch faults use PAE or IA NXE codes only after one complete transfer and repair never replays it',
      async run() {
        for (const family of ['pae', 'ia32e', 'fixed-ia32e'] as const)
          for (const nxe of [false, true])
            for (const present of [false, true])
              for (const budget of [1n, 2n])
                await usingGate(
                  compiler,
                  {
                    family,
                    mode: longFamily(family) ? 'long64' : 'protected',
                    targetCode: '90',
                    prepare(memory) {
                      put(memory, leaf(family, 2), present ? XD | 0x2067n : 0n, 8);
                    },
                  },
                  async (cpu) => {
                    const numeric = preserveNumeric(cpu);
                    const bank = cpu.readPagingState();
                    cpu.setPagingState({ ...bank, efer: bank.efer | (nxe ? 0x800n : 0n) });
                    cpu.setState(initial(SOURCE, { 3: 0x5000n, 4: 0x4000n }, 0x10002n));
                    let result = await cpu.run({ budget });
                    if (budget === 1n) {
                      complete(result);
                      equal(result.state.rip, TARGET, 'last allowance prevents destination fetch');
                      equal(result.pageFault, undefined, 'no eager destination walk');
                      result = await cpu.run({ budget: 1n });
                      equal(result.retired, 0n, 'resumed fetch cannot replay CALL');
                    } else
                      equal(
                        result.retired,
                        1n,
                        'only captured gate retired before reached target fault',
                      );
                    equal(result.reason, 'page-fault', 'destination fetch is separately reached');
                    equal(result.pageFault?.address, TARGET, 'fault names destination fetch');
                    equal(
                      result.pageFault?.errorCode,
                      present ? (nxe ? 17 : 9) : nxe ? 16 : 0,
                      'literal destination NXE fetch code',
                    );
                    equal(result.state.rip, TARGET, 'committed target remains current');
                    equal(result.state.flags, 2n, 'gate began once before destination fault');
                    equal(cpu.readContext().cpl, 0, 'fault belongs to committed callee context');
                    equal(cpu.readPagingState().cr2, TARGET, 'reached fetch publishes CR2');
                    const sp = longFamily(family) ? 0x8fe0n : 0x8ff0n;
                    equal(result.state.registers[4], sp, 'one complete frame remains committed');
                    const frame = cpu.readPhysicalMemory(sp, 0x9000 - Number(sp));
                    cpu.writePhysicalMemory(BigInt(leaf(family, 2)), little(0x2067n, 8));
                    const resumed = await cpu.run({ budget: 1n });
                    complete(resumed);
                    equal(resumed.state.rip, TARGET + 1n, 'repaired target retires NOP only');
                    equal(resumed.state.registers[4], sp, 'repair cannot push a second gate frame');
                    same(
                      cpu.readPhysicalMemory(sp, frame.length),
                      frame,
                      'repair preserves captured frame bytes',
                    );
                    numeric();
                  },
                );
      },
    },
    {
      name: 'call gate private target execute refusal follows budget or target stop and retains exactly one committed frame across repair',
      async run() {
        for (const stop of [false, true])
          await usingGate(compiler, { targetCode: '90' }, async (cpu) => {
            const numeric = preserveNumeric(cpu);
            cpu.setMappings([
              { base: 0n, backing: 'ram', offset: 0, length: 0x2000, permissions: RWX },
              {
                base: TARGET,
                backing: 'ram',
                offset: 0x2000,
                length: 0x1000,
                permissions: { ...RWX, execute: false },
              },
              {
                base: 0x3000n,
                backing: 'ram',
                offset: 0x3000,
                length: RAM_SIZE - 0x3000,
                permissions: RWX,
              },
            ]);
            cpu.setState(initial(SOURCE, { 4: 0x4000n }));
            const entered = await cpu.run({
              budget: stop ? 2n : 1n,
              ...(stop ? { stop: TARGET } : {}),
            });
            equal(
              entered.reason,
              stop ? 'stop' : 'budget',
              'post-transfer gate precedes target fetch',
            );
            equal(entered.retired, 1n, 'one captured CALL');
            equal(entered.state.registers[4], 0x8ff0n, 'committed four-slot frame');
            const frame = cpu.readMemory(0x8ff0n, 16);
            const refused = await cpu.run({ budget: 1n });
            equal(refused.reason, 'fetch-fault', 'private target execute refusal');
            equal(refused.fault?.address, TARGET, 'actual target read');
            equal(refused.fault?.cause, 'permission', 'private Execute permission');
            equal(refused.retired, 0n, 'no replay on refused target');
            same(cpu.readMemory(0x8ff0n, 16), frame, 'private refusal leaves one frame');
            cpu.setMappings([
              { base: 0n, backing: 'ram', offset: 0, length: RAM_SIZE, permissions: RWX },
            ]);
            complete(await cpu.run({ budget: 1n }));
            equal(cpu.readState().rip, TARGET + 1n, 'repaired target instruction only');
            same(cpu.readMemory(0x8ff0n, 16), frame, 'private repair never republishes gate');
            numeric();
          });
      },
    },
    {
      name: 'call gate frame payload may overwrite its own PTE while all later slots commit to the captured physical frame',
      async run() {
        await usingGate(
          compiler,
          {
            family: 'legacy32',
            newSp: 0x19068n,
            targetCode: '90',
            prepare(memory) {
              put(memory, 0x19064, 0x19023n, 4);
            },
          },
          async (cpu) => {
            const numeric = preserveNumeric(cpu);
            const low = cpu.readPhysicalMemory(0x58n, 16);
            cpu.setState(initial(SOURCE, { 4: 0x4000n }));
            const entered = await cpu.run({ budget: 1n });
            complete(entered);
            equal(entered.state.registers[4], 0x19058n, 'captured logical stack cursor');
            for (const [index, value] of [0x1007n, 0x1bn, 0x4000n, 0x23n].entries())
              equal(
                scalar(cpu, 0x19058n + BigInt(index * 4), 4, 'legacy32'),
                value,
                'captured physical frame slot',
              );
            equal(
              scalar(cpu, 0x19064n, 4, 'legacy32'),
              0x23n,
              'first SS payload replaced its own leaf after D publication',
            );
            same(
              cpu.readPhysicalMemory(0x58n, 16),
              low,
              'commit did not rewalk replacement mapping to physical page0',
            );
            complete(await cpu.run({ budget: 1n }));
            equal(cpu.readState().rip, TARGET + 1n, 'successor redispatch uses committed callee');
            equal(
              cpu.readState().registers[4],
              0x19058n,
              'no gate replay after PTE self modification',
            );
            numeric();
          },
        );
      },
    },
    {
      name: 'call gate frame overwriting active CALL bytes completes captured transfer once before callee redispatch',
      async run() {
        for (const observed of [false, true])
          await usingGate(compiler, { newSp: 0x1010n, targetCode: '90' }, async (cpu) => {
            const numeric = preserveNumeric(cpu);
            if (observed)
              cpu.setDebugState({ addresses: [0x1f000n, 0n, 0n, 0n], dr6: 0n, dr7: 0xf0401n });
            const expected = cpu.readMemory(0n, RAM_SIZE);
            for (const [index, value] of [0x1007n, 0x1bn, 0x4000n, 0x23n].entries())
              put(expected, 0x1000 + index * 4, value, 4);
            const before = initial(SOURCE, { 4: 0x4000n }, 0x10002n);
            cpu.setState(before);
            const result = await cpu.run({ budget: 2n });
            complete(result, 2n);
            equal(result.state.rip, TARGET + 1n, 'callee NOP followed completed self modification');
            equal(result.state.registers[4], SOURCE, 'one complete frame replaced CALL bytes');
            same(
              result.state.registers,
              before.registers.map((value, index) => (index === 4 ? SOURCE : value)),
              'only live stack pointer changed',
            );
            same(cpu.readMemory(0n, RAM_SIZE), expected, 'exact source/frame alias publication');
            numeric();
          });
      },
    },
    {
      name: 'call gate frame invalidates a dormant executable owner and restored context executes new literal bytes rather than cached code',
      async run() {
        const highSource = 0x90909089n;
        const options = fixtureOptions(compiler, {
          newSp: 0x3010n,
          targetCode: '90',
          prepare(memory) {
            memory.set(hex('b8efbeadde9090909090'), 0x3000);
          },
        });
        options.memory!.mappings.push({
          base: highSource,
          backing: 'ram',
          offset: 0x1000,
          length: 7,
          permissions: RWX,
        });
        const cpu = await createCpu(options);
        try {
          const numeric = preserveNumeric(cpu);
          const a = cpu.readContext();
          cpu.setState(initial(0x3000n, { 0: 0n, 4: 0x4000n }));
          complete(await cpu.run({ budget: 1n }));
          equal(cpu.readState().registers[0], 0xdeadbeefn, 'primed old MOV artifact');
          const owner = cpu.inspectTranslations()[0]!.owner;
          const b = structuredClone(a);
          b.cpl = 2;
          b.segments.cs.selector = 0x1a;
          b.segments.cs.dpl = 2;
          b.segments.ss.selector = 0x22;
          b.segments.ss.dpl = 2;
          cpu.setContext(b);
          check(
            cpu.inspectTranslations().some((unit) => unit.owner === owner),
            'old owner remains dormant before frame write',
          );
          cpu.setState(initial(highSource, { 4: 0x4000n }));
          complete(await cpu.run({ budget: 1n }));
          equal(
            scalar(cpu, 0x3000n, 4),
            0x90909090n,
            'captured high nextPC creates four literal NOP bytes',
          );
          equal(scalar(cpu, 0x3004n, 4), 0x1an, 'frame saved current caller CS');
          check(
            !cpu.inspectTranslations().some((unit) => unit.owner === owner),
            'gate frame invalidated dormant source owner',
          );
          cpu.setContext(a);
          const before = initial(0x3000n, { 0: 0x1234567800001111n, 4: 0x4000n });
          cpu.setState(before);
          const fresh = await cpu.run({ budget: 4n });
          complete(fresh, 4n);
          equal(fresh.resources.compilations, 1, 'modified dormant code needs fresh compilation');
          equal(fresh.state.rip, 0x3004n, 'four new NOP bytes instead of old MOV');
          same(fresh.state.registers, before.registers, 'old immediate value was not replayed');
          numeric();
        } finally {
          cpu.dispose();
        }
      },
    },
  ];
}
