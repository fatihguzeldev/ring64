import { createCpu } from '../../../host/index.js';
import { throws } from '../../support/fixture.js';
import { input, profiles, using as usingProfile, type Profile } from '../identity-time/oracle.js';
import {
  AC,
  AUX,
  DATA,
  PC,
  SMEP,
  SMAP,
  check,
  families,
  fixture,
  hex,
  memory,
  preserved,
  put,
  same,
  state,
  using,
  type Scenario,
} from './fixture.js';

export function supervisorContextScenarios(compiler: WebAssembly.Module): Scenario[] {
  const side = { createCpu, compiler };
  return [
    {
      name: 'supervisor AC forms keep linear and physical PG0 policies across real protected compatibility and v86 contexts',
      async run() {
        const selected: Profile[] = [
          ...profiles,
          { mode: 'real', bits: 16, family: 'pg0' },
          { mode: 'real', bits: 32, family: 'pg0' },
          { mode: 'protected', bits: 16, family: 'pg0' },
          { mode: 'protected', bits: 32, family: 'pg0' },
          { mode: 'virtual8086', bits: 16, cpl: 3, family: 'pg0' },
        ];
        for (const profile of selected) {
          const load = (profile.bits === 16 ? '6667' : '') + '8b03';
          await usingProfile(side, `0f01cb${load}0f01ca${load}`, profile, async (cpu) => {
            if (profile.family === 'pg0') {
              const bank = cpu.readPagingState();
              cpu.setPagingState({ ...bank, cr4: bank.cr4 | SMEP | SMAP });
            } else {
              throws(() => cpu.readPagingState(), 'linear has no paging control bank');
            }
            const before = input(profile);
            before.registers[3] = 0x6000n;
            cpu.setState(before);
            cpu.setTimeState({ tsc: 100n, tscAux: AUX });
            const numeric = preserved(cpu),
              context = cpu.readContext();
            const original =
              profile.family === 'pg0'
                ? cpu.readPhysicalMemory(0n, 0x50000)
                : cpu.readMemory(0n, 0x50000);
            const user = profile.mode === 'virtual8086';
            const result = await cpu.run({ budget: 4n });
            same(result.reason, user ? 'invalid-encoding' : 'budget', 'profile AC admission');
            same(result.retired, user ? 0n : 4n, 'profile AC retirement');
            const expected = structuredClone(before);
            if (!user) {
              expected.rip = PC + BigInt(6 + load.length);
              expected.registers[0] =
                profile.bits === 64 ? 0n : before.registers[0]! & 0xffffffff00000000n;
            }
            same(result.state, expected, 'profile AC and raw scalar outputs');
            same(cpu.readContext(), context, 'profile context is preserved');
            same(
              cpu.readTimeState(),
              { tsc: user ? 100n : 104n, tscAux: AUX },
              'profile exact time',
            );
            same(
              profile.family === 'pg0'
                ? cpu.readPhysicalMemory(0n, 0x50000)
                : cpu.readMemory(0n, 0x50000),
              original,
              'profile AC forms do not change memory',
            );
            numeric();
          });
        }
        for (const family of ['ia32e', 'fixed'] as const)
          for (const bits of [16, 32] as const) {
            const load = (bits === 16 ? '6667' : '') + '8b03';
            const f = fixture(side, family, `0f01cb${load}0f01ca`, { bits });
            f.paging.cr4 |= SMAP;
            f.leaf(Number(DATA), 0xa067n);
            await using(side, f, async (cpu) => {
              const before = state();
              cpu.setState(before);
              const numeric = preserved(cpu),
                result = await cpu.run({ budget: 3n });
              same(result.reason, 'budget', 'compat AC live helper');
              same(result.retired, 3n, 'compat AC retirement');
              const expected = structuredClone(before);
              expected.rip += BigInt(6 + load.length / 2);
              expected.registers[0] = 0x1122334478563412n;
              same(result.state, expected, 'compat raw dword and restored AC');
              memory(cpu, f.bytes, 'compat AC no payload');
              numeric();
            });
          }
      },
    },
    {
      name: 'supervisor full checkpoint replays controls AC and time while physical reset clears their authorities',
      async run() {
        for (const family of families) {
          const f = fixture(side, family, '0f01cb8b03');
          f.paging.cr4 |= SMEP | SMAP;
          f.leaf(Number(DATA), 0xa067n);
          await using(side, f, async (cpu) => {
            cpu.setState(state());
            cpu.setTimeState({ tsc: 100n, tscAux: AUX });
            const first = await cpu.run({ budget: 1n });
            same(first.state.flags, 2n | AC, 'checkpoint live STAC');
            cpu.setState({ ...first.state, flags: 2n });
            const pending = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
            same(pending.reason, 'event-budget', 'checkpoint selects actual pending SMAP fault');
            same(pending.retired, 0n, 'checkpoint denied load has no tick');
            same(
              pending.state.event,
              {
                kind: 'pending',
                exception: {
                  vector: 14,
                  instructionPc: PC + 3n,
                  returnPc: PC + 3n,
                  savedFlags: 0x10002n,
                  errorCode: 1,
                  pageFaultAddress: DATA,
                },
              },
              'checkpoint full pending PF source',
            );
            check(cpu.requestInterrupt(0x40), 'checkpoint queues IRQ');
            cpu.requestNmi();
            const checkpoint = {
              scalar: cpu.readState(),
              context: cpu.readContext(),
              paging: cpu.readPagingState(),
              time: cpu.readTimeState(),
              xmm: cpu.readXmmState(),
              x87: cpu.readX87State(),
              mxcsr: cpu.readMxcsr(),
              debug: cpu.readDebugState(),
              fast: cpu.readFastSystemState(),
              bytes: cpu.readPhysicalMemory(0n, f.bytes.length),
            };
            const restored = await createCpu({
              compiler,
              memoryModel: family === 'fixed' ? 'ia32e-paged' : 'physical',
              limits: f.options.limits,
              memoryLimits: { maxBackings: 8, maxMappings: 32, maxBackingBytes: 0x80000 },
              context: checkpoint.context,
              paging: checkpoint.paging,
              entry: checkpoint.scalar.rip,
              memory: {
                backings: [{ id: 'ram', bytes: checkpoint.bytes }],
                mappings: [
                  {
                    base: 0n,
                    backing: 'ram',
                    offset: 0,
                    length: checkpoint.bytes.length,
                    permissions: { read: true, write: true, execute: true },
                  },
                ],
              },
            });
            try {
              restored.setXmmState(checkpoint.xmm);
              restored.setX87State(checkpoint.x87);
              restored.setMxcsr(checkpoint.mxcsr);
              restored.setFastSystemState(checkpoint.fast);
              restored.setDebugState(checkpoint.debug);
              restored.setState(checkpoint.scalar);
              restored.setTimeState(checkpoint.time);
              same(
                restored.readPagingState(),
                checkpoint.paging,
                'checkpoint exact controls and quartet',
              );
              same(restored.readState(), checkpoint.scalar, 'checkpoint exact scalar AC');
              same(restored.readTimeState(), checkpoint.time, 'checkpoint import has no tick');
              const gated = await restored.run({ budget: 1n, eventDelivery: { budget: 0n } });
              same(gated.reason, 'event-budget', 'restored pending PF precedes IRQ and NMI');
              same(
                gated.state,
                checkpoint.scalar,
                'pending gate preserves complete restored state',
              );
              same(restored.readTimeState(), checkpoint.time, 'pending gate has no tick');
              const resumed = {
                ...checkpoint.scalar,
                flags: 2n | AC,
                event: { kind: 'ready' as const },
                interrupts: { irq: null, nmiPending: false, nmiBlocked: false },
              };
              cpu.setState(resumed);
              restored.setState(resumed);
              const a = await cpu.run({ budget: 1n }),
                b = await restored.run({ budget: 1n });
              same(a.reason, 'budget', 'original checkpoint continuation');
              same(b.reason, 'budget', 'restored checkpoint continuation');
              same(b.state, a.state, 'checkpoint continuation scalar');
              const expected = { ...resumed, registers: [...resumed.registers], rip: PC + 5n };
              expected.registers[0] = f.bits === 64 ? 0x78563412n : 0x1122334478563412n;
              same(b.state, expected, 'checkpoint independent literal continuation');
              same(
                restored.readTimeState(),
                { tsc: 102n, tscAux: AUX },
                'checkpoint restored time ledger',
              );
              memory(restored, checkpoint.bytes, 'checkpoint continuation RAM');
            } finally {
              restored.dispose();
            }
            if (family !== 'fixed') {
              cpu.reset();
              same(
                cpu.readPagingState(),
                { cr0: 0x60000010n, cr2: 0n, cr3: 0n, cr4: 0n, efer: 0n },
                'reset clears SMEP SMAP and captured quartet',
              );
              same(cpu.readState().flags, 2n, 'reset clears AC');
              same(cpu.readTimeState(), { tsc: 0n, tscAux: 0 }, 'reset clears time');
              same(cpu.inspectTranslations(), [], 'reset retires executable owners');
              memory(cpu, checkpoint.bytes, 'reset preserves physical backing');
            }
          });
        }
      },
    },
    {
      name: 'supervisor protected interrupt preserves AC until handler CLAC and wide IRET restores the saved AC',
      async run() {
        const f = fixture(side, 'non-pae', 'cd40');
        f.paging.cr4 |= SMAP;
        // Same-CPL32 interrupt gate, supervisor metadata/stack, handler CLAC; STAC; IRETD.
        f.bytes.set(hex('00400800008e0000'), 0xc200);
        f.bytes.set(hex('0f01ca0f01cbcf'), 0x9000);
        await using(side, f, async (cpu) => {
          const before = state(0x202n | AC);
          cpu.setState(before);
          cpu.setTimeState({ tsc: 100n, tscAux: AUX });
          const numeric = preserved(cpu),
            context = cpu.readContext();
          const entered = await cpu.run({ budget: 1n });
          same(entered.reason, 'budget', 'protected interrupt entry');
          same(entered.state.flags, 2n | AC, 'protected entry preserves AC and clears IF');
          same(entered.state.rip, 0x4000n, 'protected handler target');
          same(entered.state.registers[4], 0x9fe4n, 'protected exact frame pointer');
          const expected = f.bytes.slice();
          for (const [at, value] of [
            [0xdfe4, PC + 2n],
            [0xdfe8, 8n],
            [0xdfec, 0x202n | AC],
          ] as const)
            put(expected, at, value, 4);
          memory(cpu, expected, 'protected full frame and memory');
          const cleared = await cpu.run({ budget: 1n });
          same(cleared.state.flags, 2n, 'handler CLAC is explicit');
          same((await cpu.run({ budget: 1n })).state.flags, 2n | AC, 'handler STAC is explicit');
          const returned = await cpu.run({ budget: 1n });
          check(returned.reason === 'budget', 'wide IRET succeeds');
          same(returned.state, { ...before, rip: PC + 2n }, 'wide IRET restores saved full AC');
          same(cpu.readContext(), context, 'wide IRET context');
          same(
            cpu.readTimeState(),
            { tsc: 104n, tscAux: AUX },
            'entry handler return exact ledger',
          );
          memory(cpu, expected, 'IRET retains saved frame');
          numeric();
        });
      },
    },
  ];
}
