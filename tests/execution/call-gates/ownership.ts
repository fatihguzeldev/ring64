import {
  usingGate,
  initial,
  complete,
  equal,
  check,
  same,
  scalar,
  put,
  hex,
  gateDescriptor,
  SOURCE,
  TARGET,
  GDT,
  RAM_SIZE,
  type Scenario,
} from './fixture.js';

export function gateOwnershipScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'call gate and RETF alternate through one cache slot and an evicted owner rereads the changed gate',
      async run() {
        await usingGate(
          compiler,
          { limit: { maxCachedArtifacts: 1, maxTranslationsPerRun: 1 } },
          async (cpu) => {
            cpu.setState(initial(SOURCE, { 4: 0x4000n }));
            complete(await cpu.run({ budget: 1n }));
            const source = cpu.inspectTranslations()[0]!.owner;
            equal(cpu.inspectTranslations().length, 1, 'one admitted source owner');
            equal(cpu.readState().rip, TARGET, 'first gate target');
            const returned = await cpu.run({ budget: 1n });
            complete(returned);
            equal(returned.state.rip, 0x1007n, 'RETF completes under the same cache quota');
            equal(returned.state.registers[4], 0x4000n, 'caller pointer restored');
            equal(cpu.readContext().cpl, 3, 'caller context restored');
            const target = cpu.inspectTranslations()[0]!.owner;
            equal(cpu.inspectTranslations().length, 1, 'RETF evicts the dormant source');
            check(target !== source, 'target has a distinct owner');
            check(
              !cpu.inspectTranslations().some((unit) => unit.owner === source),
              'source owner is absent after eviction',
            );
            cpu.writeMemory(GDT + 0x38n, gateDescriptor(32, 0, 0x3000n));
            cpu.setState(initial(SOURCE, { 4: 0x4000n }));
            const entered = await cpu.run({ budget: 1n });
            complete(entered);
            equal(entered.resources.compilations, 1, 'evicted source needs one fresh owner');
            equal(entered.resources.nativeEntries, 1, 'gate executes once after admission');
            equal(entered.state.rip, 0x3000n, 'fresh gate meaning is read at runtime');
            equal(entered.state.registers[4], 0x8ff0n, 'exactly one new gate frame');
            equal(cpu.readContext().cpl, 0, 'fresh privilege publication');
            for (const [index, value] of [0x1007n, 0x1bn, 0x4000n, 0x23n].entries())
              equal(scalar(cpu, 0x8ff0n + BigInt(index * 4), 4), value, `fresh slot ${index}`);
            const owners = cpu.inspectTranslations();
            equal(owners.length, 1, 'bounded cache remains usable');
            check(
              owners[0]!.owner !== source && owners[0]!.owner !== target,
              'neither evicted identity is resurrected',
            );
          },
        );
      },
    },
    {
      name: 'call gate backing reincarnation cannot revive source or target owners and copies replacement arguments',
      async run() {
        await usingGate(compiler, {}, async (cpu) => {
          cpu.setState(initial(SOURCE, { 4: 0x4000n }));
          complete(await cpu.run({ budget: 1n }));
          complete(await cpu.run({ budget: 1n }));
          const oldOwners = cpu.inspectTranslations().map((unit) => unit.owner);
          equal(oldOwners.length, 2, 'both sides of the round trip are resident');
          const replacement = cpu.readMemory(0n, RAM_SIZE);
          replacement.set(gateDescriptor(32, 1, 0x3000n), Number(GDT) + 0x38);
          replacement.set(hex('ca0400'), 0x3000);
          put(replacement, 0x4000, 0x87654321n, 4);
          replacement.fill(0xa5, 0x8fe0, 0x9000);
          cpu.setMappings([]);
          cpu.removeBacking('ram');
          cpu.addBacking({ id: 'ram', bytes: replacement });
          cpu.setMappings([
            {
              base: 0n,
              backing: 'ram',
              offset: 0,
              length: RAM_SIZE,
              permissions: { read: true, write: true, execute: true },
            },
          ]);
          check(
            cpu.inspectTranslations().every((unit) => !oldOwners.includes(unit.owner)),
            'reused public backing id cannot resurrect either old owner',
          );
          cpu.setState(initial(SOURCE, { 4: 0x4000n }));
          const entered = await cpu.run({ budget: 1n });
          complete(entered);
          equal(entered.resources.compilations, 1, 'replacement source gets a fresh owner');
          equal(entered.resources.nativeEntries, 1, 'replacement gate executes once');
          equal(entered.state.rip, 0x3000n, 'replacement gate target');
          equal(entered.state.registers[4], 0x8fecn, 'replacement parameter count');
          for (const [index, value] of [0x1007n, 0x1bn, 0x87654321n, 0x4000n, 0x23n].entries())
            equal(scalar(cpu, 0x8fecn + BigInt(index * 4), 4), value, `replacement slot ${index}`);
          const frame = cpu.readMemory(0x8fecn, 20);
          const returned = await cpu.run({ budget: 1n });
          complete(returned);
          equal(returned.state.rip, 0x1007n, 'replacement callee returns to caller');
          equal(
            returned.state.registers[4],
            0x4004n,
            'replacement RETF cleans both argument areas',
          );
          equal(cpu.readContext().cpl, 3, 'replacement return restores caller privilege');
          same(cpu.readMemory(0x8fecn, 20), frame, 'return does not replay the gate frame');
          check(
            cpu.inspectTranslations().every((unit) => !oldOwners.includes(unit.owner)),
            'fresh execution never adopts an old incarnation owner',
          );
        });
      },
    },
  ];
}
