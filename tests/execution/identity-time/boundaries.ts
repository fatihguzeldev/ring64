import { createCpu, type Cpu } from '../../../host/index.js';
import { equal, hex, initial, throws, type Scenario } from '../../support/fixture.js';
import { using, snapshot, same, preserveNumeric } from '../far-control/fixture.js';
import { usingGate } from '../call-gates/fixture.js';
import { gate, image } from '../software-events/fixture.js';
import {
  using as usingTime,
  input,
  execution,
  controls,
  ENTRY,
  AUX,
  type Profile,
} from './oracle.js';

function time(cpu: Cpu, tsc: bigint, tscAux = AUX): void {
  same(cpu.readTimeState(), { tsc, tscAux }, 'independent boundary bank');
}
const sample = (cpu: Cpu) => {
  const registers = cpu.readState().registers;
  return (registers[2]! << 32n) | registers[0]!;
};

export function identityBoundaryScenarios(compiler: WebAssembly.Module): Scenario[] {
  const side = { createCpu, compiler };
  return [
    {
      name: 'controlled TSD numeric and debug refusals retain literal execute RF LOCK and required-byte priority',
      async run() {
        const profile: Profile = { mode: 'protected', bits: 32, family: 'pg0', cpl: 3 };
        for (const code of ['0f31', '0f01f9', 'f00f31', 'f00f01f9'])
          await usingTime(side, code, profile, async (cpu) => {
            const numeric = preserveNumeric(cpu),
              bank = cpu.readPagingState();
            cpu.setPagingState({ ...bank, cr0: bank.cr0 | 0xcn, cr4: (bank.cr4 & ~0x600n) | 4n });
            cpu.setDebugState({ addresses: [ENTRY, 0n, 0n, 0n], dr6: 0n, dr7: 0x401n });
            cpu.setState({ ...input(profile), flags: 0x202n });
            cpu.setTimeState({ tsc: 100n, tscAux: AUX });
            const before = cpu.readState();
            const hit = await cpu.run({ budget: 1n });
            equal(
              hit.reason,
              'debug-exception',
              'execute breakpoint precedes TSD numeric and LOCK checks',
            );
            same(
              hit.debugException,
              {
                vector: 1,
                class: 'fault',
                cause: 'execution-breakpoint',
                breakpoints: 1,
                instructionPc: ENTRY,
                resumePc: ENTRY,
                instructionCompleted: false,
                resumeFlags: 0x202n,
              },
              'literal RF0 execute report',
            );
            same(hit.state, before, 'pre-begin execute report preserves all scalar state');
            equal(hit.retired, 0n, 'execute refusal retires zero');
            time(cpu, 100n);
            cpu.setState({ ...before, flags: 0x10202n });
            const resumed = await cpu.run({ budget: 1n });
            const locked = code.startsWith('f0');
            equal(
              resumed.reason,
              locked ? 'invalid-encoding' : 'protection-fault',
              'RF exposes LOCK or live TSD before numeric waits',
            );
            equal(resumed.retired, 0n, 'exposed refusal retires zero');
            equal(resumed.remaining, 1n, 'exposed refusal keeps allowance');
            same(
              resumed.state.registers,
              before.registers,
              'no refused read publishes raw outputs',
            );
            equal(
              resumed.state.flags,
              locked ? 0x10202n : 0x202n,
              'decode preserves RF while TSD fails after begin',
            );
            equal(resumed.state.rip, ENTRY, 'refusal retains source PC');
            equal(resumed.debugException, undefined, 'RF suppresses the execute comparator');
            equal(resumed.deviceNotAvailable, undefined, 'nonnumeric timestamp cannot report NM');
            equal(resumed.x87Exception, undefined, 'pending x87 cannot replace selected refusal');
            if (!locked)
              same(
                resumed.protectionFault,
                { vector: 13, errorCode: 0, phase: 'privilege', instructionPc: ENTRY },
                'literal RF1 TSD report',
              );
            time(cpu, 100n);
            numeric();
          });
        for (const code of ['0f01f9', 'f00f01f9'])
          await usingTime(side, code, profile, async (cpu) => {
            const numeric = preserveNumeric(cpu),
              bank = cpu.readPagingState();
            cpu.setPagingState({ ...bank, cr0: bank.cr0 | 0xcn, cr4: (bank.cr4 & ~0x600n) | 4n });
            const missing = ENTRY + BigInt(code.length / 2 - 1),
              after = missing + 1n;
            cpu.setMappings([
              {
                base: 0n,
                backing: 'ram',
                offset: 0,
                length: Number(missing),
                permissions: { read: true, write: true, execute: true },
              },
              {
                base: after,
                backing: 'ram',
                offset: Number(after),
                length: 0x50000 - Number(after),
                permissions: { read: true, write: true, execute: true },
              },
            ]);
            cpu.setDebugState({ addresses: [ENTRY, 0n, 0n, 0n], dr6: 0n, dr7: 0x401n });
            cpu.setState({ ...input(profile), flags: 0x10202n });
            cpu.setTimeState({ tsc: 100n, tscAux: AUX });
            const before = cpu.readState(),
              refused = await cpu.run({ budget: 1n });
            equal(
              refused.reason,
              'physical-memory-fault',
              'required F9 fetch precedes LOCK TSD and numeric checks',
            );
            same(
              refused.physicalMemoryFault,
              {
                instructionPc: ENTRY,
                address: missing,
                access: 'execute',
                physicalAddress: missing,
                width: 1,
                failingPhysicalAddress: missing,
                physicalAccess: 'execute',
                cause: 'unmapped',
                phase: 'final-access',
                segment: 'cs',
              },
              'literal missing required F9 physical report',
            );
            same(refused.state, before, 'required-byte refusal preserves RF and every raw output');
            equal(refused.retired, 0n, 'required-byte refusal performs no retirement');
            equal(refused.remaining, 1n, 'required-byte refusal keeps allowance');
            equal(refused.protectionFault, undefined, 'no premature TSD or LOCK report');
            equal(refused.deviceNotAvailable, undefined, 'required-byte failure is not numeric');
            time(cpu, 100n);
            numeric();
          });
      },
    },
    {
      name: 'active debug misses preserve full identity timestamp traces across partitions and cached middle entries',
      async run() {
        for (const profile of [
          { mode: 'protected', bits: 16 },
          { mode: 'protected', bits: 32 },
          { mode: 'long64', bits: 64 },
          { mode: 'long64', bits: 64, family: 'fixed' },
        ] as Profile[]) {
          const prefix = profile.bits === 16 ? '66' : '';
          const parts = ['90', prefix + 'b800000000', '0fa2', '0f31', prefix + '89c3', '0f01f9'];
          await usingTime(side, parts.join(''), profile, async (cpu) => {
            const numeric = preserveNumeric(cpu);
            cpu.setDebugState({ addresses: [0x7ff0n, 0n, 0n, 0n], dr6: 0n, dr7: 0x401n });
            const debug = cpu.readDebugState(),
              before = input(profile);
            const advance = (state: ReturnType<typeof input>, step: number, tsc: bigint) => {
              const r = state.registers;
              if (step === 1) r[0] = profile.bits === 64 ? 0n : r[0]! & 0xffffffff00000000n;
              if (step === 2)
                [r[0], r[3], r[1], r[2]] = [7n, 0x676e6952n, 0x656e6967n, 0x6e453436n];
              if (step === 3 || step === 5) {
                r[0] = tsc & 0xffffffffn;
                r[2] = tsc >> 32n;
              }
              if (step === 4) r[3] = r[0]!;
              if (step === 5) r[1] = BigInt(AUX);
              state.rip += BigInt(parts[step]!.length / 2);
            };
            const verify = (
              state: ReturnType<typeof input>,
              result: Awaited<ReturnType<Cpu['run']>>,
              tsc: bigint,
            ) => {
              equal(result.reason, 'budget', 'active miss has no debug event');
              equal(result.debugException, undefined, 'active miss has no debug source');
              same(
                result.state,
                state,
                'literal active-miss full scalar registers flags and event',
              );
              same(cpu.readDebugState(), debug, 'active miss preserves comparator and DR6');
              time(cpu, tsc);
            };
            cpu.setState(before);
            cpu.setTimeState({ tsc: 100n, tscAux: AUX });
            const primed = structuredClone(before);
            for (let step = 0; step < parts.length; step++)
              advance(primed, step, 100n + BigInt(step));
            verify(primed, await cpu.run({ budget: 6n }), 106n);
            const owners = cpu.inspectTranslations().map((unit) => unit.owner);
            for (const split of [[6], [1, 5], [2, 1, 3], [1, 1, 1, 1, 1, 1]]) {
              cpu.setState(before);
              cpu.setTimeState({ tsc: 100n, tscAux: AUX });
              const wanted = structuredClone(before);
              let reached = 0;
              for (const budget of split) {
                for (let i = 0; i < budget; i++) advance(wanted, reached, 100n + BigInt(reached++));
                const result = await cpu.run({ budget: BigInt(budget) });
                equal(
                  result.retired,
                  BigInt(budget),
                  'active miss independently reached instructions',
                );
                equal(
                  result.resources.compilations,
                  0,
                  'active miss partitions retain warmed code',
                );
                verify(wanted, result, 100n + BigInt(reached));
              }
              same(
                cpu.inspectTranslations().map((unit) => unit.owner),
                owners,
                'active miss partitions retain exact owners',
              );
            }
            const middle = structuredClone(before);
            for (let step = 0; step < 3; step++) advance(middle, step, 0n);
            cpu.setState(middle);
            cpu.setTimeState({ tsc: 700n, tscAux: AUX });
            const wanted = structuredClone(middle);
            for (let step = 3; step < 6; step++) advance(wanted, step, 700n + BigInt(step - 3));
            const cached = await cpu.run({ budget: 3n });
            equal(cached.resources.compilations, 0, 'active miss uses a cached middle entry');
            equal(cached.retired, 3n, 'cached middle trace has three actual instructions');
            verify(wanted, cached, 703n);
            numeric();
          });
        }
      },
    },
    {
      name: 'warm CPL3 timestamp owners read TSD changes live without recompilation or output publication on refusal',
      async run() {
        const profiles: Profile[] = [
          ...controls.filter((profile) => profile.mode !== 'real'),
          { mode: 'virtual8086', bits: 16, family: 'pg0' },
        ];
        for (const selected of profiles)
          for (const code of ['0f31', '0f01f9']) {
            const profile = { ...selected, cpl: 3 };
            await usingTime(side, code, profile, async (cpu) => {
              const before = input(profile);
              const bank = cpu.readPagingState();
              cpu.setTimeState({ tsc: 100n, tscAux: AUX });
              const warm = await cpu.run({ budget: 1n });
              const expected = [...before.registers];
              expected[0] = 100n;
              expected[2] = 0n;
              if (code === '0f01f9') expected[1] = BigInt(AUX);
              equal(warm.reason, 'budget', 'TSD0 warms a real CPL3 read');
              same(warm.state.registers, expected, 'first read full raw outputs');
              equal(warm.state.flags, before.flags, 'first read preserves flags');
              time(cpu, 101n);
              const owners = cpu.inspectTranslations().map((unit) => unit.owner);
              cpu.setState(before);
              cpu.setPagingState({ ...bank, cr4: bank.cr4 | 4n });
              time(cpu, 101n);
              const refused = await cpu.run({ budget: 1n });
              equal(refused.reason, 'protection-fault', 'warm TSD1 denies this same CPL3 read');
              equal(refused.retired, 0n, 'warm denied read does not retire');
              equal(refused.remaining, 1n, 'warm denied read preserves allowance');
              equal(refused.resources.compilations, 0, 'permission toggle does not compile');
              equal(refused.protectionFault?.vector, 13, 'warm TSD vector');
              equal(refused.protectionFault?.errorCode, 0, 'warm TSD zero code');
              equal(refused.protectionFault?.phase, 'privilege', 'warm TSD phase');
              same(
                refused.state.registers,
                before.registers,
                'warm denial publishes no raw output',
              );
              equal(refused.state.flags, before.flags, 'warm denial preserves ordinary flags');
              equal(refused.state.rip, ENTRY, 'warm denial retains source PC');
              time(cpu, 101n);
              same(
                cpu.inspectTranslations().map((unit) => unit.owner),
                owners,
                'denial retains the exact cached owners',
              );
              cpu.setState(before);
              cpu.setPagingState(bank);
              const admitted = await cpu.run({ budget: 1n });
              expected[0] = 101n;
              equal(admitted.reason, 'budget', 'cleared TSD reuses this same CPL3 read');
              equal(admitted.retired, 1n, 're-admitted read retires once');
              equal(admitted.resources.compilations, 0, 'TSD0 re-admission stays warm');
              same(
                admitted.state.registers,
                expected,
                're-admitted live sample and full raw output',
              );
              equal(admitted.state.flags, before.flags, 're-admitted read preserves flags');
              equal(
                admitted.state.rip,
                ENTRY + BigInt(code.length / 2),
                're-admitted exact continuation',
              );
              time(cpu, 102n);
              same(
                cpu.inspectTranslations().map((unit) => unit.owner),
                owners,
                're-admission retains exact owners',
              );
            });
          }
      },
    },
    {
      name: 'same physical CPU returns identical CPUID words after reset and matching real context import',
      async run() {
        await usingTime(
          side,
          '0fa2',
          { mode: 'protected', bits: 32, family: 'pg0' },
          async (cpu) => {
            const words = [7n, 0x676e6952n, 0x656e6967n, 0x6e453436n];
            const registers = [0, 3, 1, 2];
            const before = cpu.readState();
            before.registers[0] = 0n;
            cpu.setState(before);
            cpu.setTimeState({ tsc: 100n, tscAux: AUX });
            const first = await cpu.run({ budget: 1n });
            same(
              registers.map((register) => first.state.registers[register]),
              words,
              'pre-reset literal CPUID words',
            );
            time(cpu, 101n);
            cpu.reset();
            time(cpu, 0n, 0);
            const real: Profile = { mode: 'real', bits: 16 };
            cpu.setContext(execution(real));
            const restored = input(real);
            restored.registers[0] = 0n;
            cpu.setState(restored);
            const second = await cpu.run({ budget: 1n });
            equal(second.reason, 'budget', 'post-reset real-mode CPUID admission');
            equal(second.retired, 1n, 'post-reset one actual instruction');
            same(
              registers.map((register) => second.state.registers[register]),
              words,
              'same CPU post-reset literal CPUID words',
            );
            const expected = [...restored.registers];
            for (const [index, register] of registers.entries()) expected[register] = words[index]!;
            same(
              second.state.registers,
              expected,
              'reset/profile change leaves all unrelated raw banks',
            );
            equal(second.state.flags, restored.flags, 'post-reset CPUID preserves flags');
            time(cpu, 1n, 0);
          },
        );
      },
    },
    {
      name: 'host delays before and between guest work never advance the private clock',
      async run() {
        await usingTime(side, '900f31', { mode: 'long64', bits: 64 }, async (cpu) => {
          cpu.setTimeState({ tsc: 100n, tscAux: AUX });
          await new Promise((done) => setTimeout(done, 16));
          time(cpu, 100n);
          equal((await cpu.run({ budget: 1n })).retired, 1n, 'one NOP before host pause');
          time(cpu, 101n);
          await new Promise((done) => setTimeout(done, 16));
          time(cpu, 101n);
          const read = await cpu.run({ budget: 1n });
          equal(read.retired, 1n, 'one read after host pause');
          equal(sample(cpu), 101n, 'host delay does not enter the timestamp');
          time(cpu, 102n);
        });
      },
    },
    {
      name: 'virtual time decode boundaries preserve LOCK fetch length RF and neighbor priority',
      async run() {
        for (const [code, reason] of [
          ['f00fa2', 'invalid-encoding'],
          ['f00f31', 'invalid-encoding'],
          ['f00f01f9', 'invalid-encoding'],
          ['f0f00f31', 'unsupported'],
          ['f0f30f31', 'unsupported'],
          ['f3f00f31', 'unsupported'],
          ['0f', 'fetch-fault'],
          ['0f01', 'fetch-fault'],
          ['f00f01', 'fetch-fault'],
          ['66'.repeat(14) + '0f', 'invalid-encoding'],
          ['66'.repeat(13) + '0f01', 'invalid-encoding'],
          ['0f01fa', 'unsupported'],
          ['0f33', 'unsupported'],
        ] as const)
          await using(compiler, code, snapshot(), async (cpu) => {
            cpu.setState(initial(ENTRY, {}, 0x10202n));
            cpu.setTimeState({ tsc: 100n, tscAux: AUX });
            const report = await cpu.run({ budget: 1n });
            equal(report.reason, reason, `literal required-byte/frontier packet ${code}`);
            equal(report.retired, 0n, 'decode refusal retires no instruction');
            time(cpu, 100n);
            if (reason === 'invalid-encoding') {
              equal(report.state.flags, 0x10202n, 'pre-begin report keeps RF');
              const pending = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
              equal(pending.state.event.kind, 'pending', 'selected decode pending event');
              time(cpu, 100n);
              equal(pending.state.flags, 0x202n, 'captured decode begin clears live RF');
            }
          });
      },
    },
    {
      name: 'identity and clocks ignore disabled numeric controls and pending x87 while waiting work does not tick',
      async run() {
        const profile: Profile = { mode: 'protected', bits: 32, family: 'pg0' };
        await usingTime(side, '0fa20f310f01f99b', profile, async (cpu) => {
          const numeric = preserveNumeric(cpu);
          const paging = cpu.readPagingState();
          cpu.setPagingState({ ...paging, cr0: paging.cr0 | 0x2cn, cr4: paging.cr4 & ~0x600n });
          cpu.setTimeState({ tsc: 100n, tscAux: AUX });
          const accepted = await cpu.run({ budget: 3n });
          equal(
            accepted.reason,
            'budget',
            'nonnumeric selected forms ignore EM TS OSFXSR and pending',
          );
          equal(sample(cpu), 102n, 'three known forms sample');
          time(cpu, 103n);
          numeric();
          const waiting = await cpu.run({ budget: 1n });
          equal(waiting.retired, 0n, 'waiting numeric fault no retirement');
          time(cpu, 103n);
        });
      },
    },
    {
      name: 'TSD host and guest changes keep warmed owners and cached PAE PDPTEs without clock side effects',
      async run() {
        for (const profile of [
          { mode: 'protected', bits: 32, family: 'pae' },
          { mode: 'long64', bits: 64, family: 'ia32e' },
          { mode: 'long64', bits: 64, family: 'fixed' },
        ] as Profile[])
          await usingTime(side, '0f01f90f22e0', profile, async (cpu) => {
            cpu.setTimeState({ tsc: 100n, tscAux: AUX });
            await cpu.run({ budget: 1n });
            const owner = cpu.inspectTranslations()[0]!.owner;
            const bank = cpu.readPagingState();
            if (profile.family === 'pae') cpu.writePhysicalMemory(0x40000n, new Uint8Array(8));
            cpu.setPagingState({ ...bank, cr4: bank.cr4 | 4n });
            time(cpu, 101n);
            equal(
              cpu.inspectTranslations().some((unit) => unit.owner === owner),
              true,
              'TSD host import keeps published owner',
            );
            const state = input(profile);
            state.registers[0] = bank.cr4;
            state.rip = ENTRY + 3n;
            cpu.setState(state);
            equal(
              (await cpu.run({ budget: 1n })).reason,
              'budget',
              'guest TSD-only write admits and does not reload PDPTE',
            );
            time(cpu, 102n);
            cpu.setState(input(profile));
            cpu.setTimeState({ tsc: 777n, tscAux: 7 });
            const warm = await cpu.run({ budget: 1n });
            equal(warm.resources.compilations, 0, 'TSD-only control preserves warm source');
            equal(sample(cpu), 777n, 'warm time live');
            equal(warm.state.registers[1], 7n, 'warm AUX live');
            time(cpu, 778n, 7);
          });
      },
    },
    {
      name: 'TSD guest GP handler clears permission IRETs and retries with a literal privilege frame',
      async run() {
        await usingGate(
          compiler,
          {
            family: 'pg0',
            cpl: 3,
            code: '0f31',
            targetCode: '0f20e083e0fb0f22e083c404cf',
            prepare(bytes, context) {
              context.idtr = { base: 0xa000n, limit: 0x7ff };
              bytes.set(hex(gate(32, 8, 0x2000n, 0)), 0xa000 + 13 * 8);
            },
          },
          async (cpu) => {
            const bank = cpu.readPagingState();
            cpu.setPagingState({ ...bank, cr4: bank.cr4 | 4n });
            cpu.setState(initial(ENTRY, { 4: 0x4000n }, 0x202n));
            cpu.setTimeState({ tsc: 100n, tscAux: AUX });
            const staged = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
            equal(staged.retired, 0n, 'refused source no retirement');
            time(cpu, 100n);
            same(
              staged.state.event,
              {
                kind: 'pending',
                exception: {
                  vector: 13,
                  instructionPc: ENTRY,
                  returnPc: ENTRY,
                  savedFlags: 0x10202n,
                  errorCode: 0,
                },
              },
              'literal GP source image',
            );
            const entered = await cpu.run({
              budget: 1n,
              stop: 0x2000n,
              eventDelivery: { budget: 1n },
            });
            equal(entered.retired, 0n, 'entry frame no retirement');
            time(cpu, 100n);
            same(
              cpu.readPhysicalMemory(0x8fe8n, 24),
              image([0n, ENTRY, 0x1bn, 0x10202n, 0x4000n, 0x23n], 4),
              'literal GP privilege frame',
            );
            const retried = await cpu.run({ budget: 6n, eventDelivery: { budget: 1n } });
            equal(retried.reason, 'budget', 'handler and retry complete');
            equal(retried.retired, 6n, 'five handler instructions plus source');
            equal(sample(cpu), 105n, 'source samples after actual handler work');
            equal(cpu.readContext().cpl, 3, 'IRET restored caller');
            equal(retried.state.registers[4], 0x4000n, 'IRET restored stack');
            time(cpu, 106n);
          },
        );
      },
    },
    {
      name: 'partial REP I/O committed elements and later permission failure retain only the retired prefix tick',
      async run() {
        const profile: Profile = { mode: 'protected', bits: 32, cpl: 3 };
        let calls = 0;
        await usingTime(
          side,
          '90f36c0f31',
          profile,
          async (cpu) => {
            const context = cpu.readContext();
            context.tr = {
              selector: 0x28,
              valid: true,
              base: 0x8000n,
              limit: 0x81,
              attributes: 0x8b,
            };
            cpu.setContext(context);
            cpu.writeMemory(0x8066n, hex('8000'));
            cpu.writeMemory(0x8080n, hex('00ff'));
            cpu.setState(initial(ENTRY, { 1: 2n, 2: 7n, 7: 0x8080n }));
            cpu.setTimeState({ tsc: 100n, tscAux: AUX });
            const first = await cpu.run({ budget: 3n, repeatBudget: 2n });
            equal(first.reason, 'protection-fault', 'second bitmap lookup sees first store');
            equal(first.repeatIterations, 1n, 'one committed input');
            equal(first.retired, 1n, 'NOP only retired');
            equal(calls, 1, 'denied element has no callback');
            time(cpu, 101n);
            cpu.writeMemory(0x8080n, hex('00'));
            const last = await cpu.run({ budget: 2n, repeatBudget: 1n });
            equal(last.retired, 2n, 'one REP retirement and read');
            equal(sample(cpu), 102n, 'repaired REP single clock tick');
            equal(calls, 2, 'completed input not replayed');
            time(cpu, 103n);
          },
          {
            io: {
              read() {
                return calls++ === 0 ? 0x80 : 0xaa;
              },
              write() {},
            },
          },
        );
      },
    },
    {
      name: 'time scalar checkpoint ready pending reset and detached import retain distinct ownership',
      async run() {
        await usingTime(
          side,
          '0f310f01f9',
          { mode: 'protected', bits: 32, family: 'pg0' },
          async (cpu) => {
            const numeric = preserveNumeric(cpu);
            const state = cpu.readState();
            state.flags |= 0x100n;
            cpu.setState(state);
            cpu.setTimeState({ tsc: 100n, tscAux: AUX });
            const pending = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
            const checkpoint = {
              state: cpu.readState(),
              context: cpu.readContext(),
              paging: cpu.readPagingState(),
              time: cpu.readTimeState(),
              debug: cpu.readDebugState(),
              fast: cpu.readFastSystemState(),
              xmm: cpu.readXmmState(),
              mxcsr: cpu.readMxcsr(),
              x87: cpu.readX87State(),
              memory: cpu.readPhysicalMemory(0n, 0x50000),
            };
            equal(pending.retired, 1n, 'checkpoint reached one completed timestamp');
            time(cpu, 101n);
            cpu.setTimeState({ tsc: 999n, tscAux: 7 });
            same(
              cpu.readState().event,
              checkpoint.state.event,
              'time bank repair preserves captured pending source',
            );
            cpu.setState(checkpoint.state);
            time(cpu, 999n, 7);
            cpu.setTimeState(checkpoint.time);
            time(cpu, 101n);
            same(cpu.readContext(), checkpoint.context, 'time bank does not change context');
            same(cpu.readPagingState(), checkpoint.paging, 'time bank does not change paging');
            same(cpu.readDebugState(), checkpoint.debug, 'time bank does not change debug');
            same(
              cpu.readFastSystemState(),
              checkpoint.fast,
              'time bank does not change fast system',
            );
            numeric();
            cpu.reset();
            time(cpu, 0n, 0);
            equal(
              cpu.readState().event.kind,
              'ready',
              'reset clears pending through existing owner',
            );
            const restored = await createCpu({
              compiler,
              context: checkpoint.context,
              memoryModel: 'physical',
              paging: checkpoint.paging,
              entry: checkpoint.state.rip,
              memory: {
                backings: [{ id: 'ram', bytes: checkpoint.memory }],
                mappings: [
                  {
                    base: 0n,
                    backing: 'ram',
                    offset: 0,
                    length: checkpoint.memory.length,
                    permissions: { read: true, write: true, execute: true },
                  },
                ],
              },
              memoryLimits: {
                maxBackings: 1,
                maxMappings: 1,
                maxBackingBytes: checkpoint.memory.length,
              },
              limits: {
                maxInstructions: 8,
                maxSourceBytes: 64,
                maxArtifactBytes: 131072,
                maxCachedArtifacts: 8,
                maxCachedBytes: 1048576,
                maxTranslationsPerRun: 8,
              },
            });
            try {
              restored.setXmmState(checkpoint.xmm);
              restored.setMxcsr(checkpoint.mxcsr);
              restored.setX87State(checkpoint.x87);
              restored.setFastSystemState(checkpoint.fast);
              restored.setDebugState(checkpoint.debug);
              restored.setState(checkpoint.state);
              restored.setTimeState(checkpoint.time);
              same(restored.readState(), checkpoint.state, 'full pending scalar and event replay');
              same(restored.readContext(), checkpoint.context, 'full context replay');
              same(restored.readPagingState(), checkpoint.paging, 'full paging replay');
              same(
                [restored.readXmmState(), restored.readMxcsr(), restored.readX87State()],
                [checkpoint.xmm, checkpoint.mxcsr, checkpoint.x87],
                'full numeric replay',
              );
              same(restored.readDebugState(), checkpoint.debug, 'full debug replay');
              same(restored.readFastSystemState(), checkpoint.fast, 'full selected MSR replay');
              same(
                restored.readPhysicalMemory(0n, 0x50000),
                checkpoint.memory,
                'full memory replay',
              );
              time(restored, 101n);
              const replayed = await restored.run({ budget: 1n, eventDelivery: { budget: 0n } });
              same(
                replayed.state.event,
                checkpoint.state.event,
                'replayed pending event survives zero delivery allowance',
              );
              equal(replayed.retired, 0n, 'pending replay executes no guest instruction');
              time(restored, 101n);
            } finally {
              restored.dispose();
            }
          },
        );
      },
    },
    {
      name: 'time completed warm runs during capture reject without rolling back run reset dispose or other bank effects',
      async run() {
        await usingTime(side, '90', { mode: 'long64', bits: 64 }, async (cpu) => {
          await cpu.run({ budget: 1n });
          cpu.setState(input({ mode: 'long64', bits: 64 }));
          cpu.setTimeState({ tsc: 100n, tscAux: AUX });
          let run: Promise<unknown> | undefined;
          throws(
            () =>
              cpu.setTimeState({
                get tsc() {
                  run = cpu.run({ budget: 1n });
                  return 500n;
                },
                tscAux: 7,
              }),
            'completed warm run invalidates capture',
          );
          await run;
          time(cpu, 101n);
          throws(
            () =>
              cpu.setTimeState({
                get tsc() {
                  cpu.setTimeState({ tsc: 321n, tscAux: 3 });
                  return -1n;
                },
                tscAux: 7,
              }),
            'invalid outer setter after independent import',
          );
          time(cpu, 321n, 3);
          throws(
            () =>
              cpu.setTimeState({
                get tsc() {
                  cpu.dispose();
                  return 500n;
                },
                tscAux: 7,
              }),
            'dispose invalidates capture',
          );
          throws(() => cpu.readTimeState(), 'accessor disposal is retained');
        });
      },
    },
    {
      name: 'virtual time independent CPUs compiler reuse aliases cache eviction and context ABA never freeze the bank',
      async run() {
        const a = snapshot(),
          b = snapshot();
        b.segments.fs.base = 0x100n;
        const bytes = hex('900f31');
        const mappings = [
          {
            base: ENTRY,
            backing: 'code',
            offset: 0,
            length: 3,
            permissions: { read: true, write: true, execute: true },
          },
          {
            base: 0x2000n,
            backing: 'code',
            offset: 0,
            length: 3,
            permissions: { read: true, write: true, execute: true },
          },
        ];
        const make = () =>
          createCpu({
            compiler,
            context: a,
            entry: ENTRY,
            memory: { backings: [{ id: 'code', bytes }], mappings },
            memoryLimits: { maxBackings: 1, maxMappings: 2, maxBackingBytes: 3 },
            limits: {
              maxInstructions: 8,
              maxSourceBytes: 32,
              maxArtifactBytes: 131072,
              maxCachedArtifacts: 1,
              maxCachedBytes: 131072,
              maxTranslationsPerRun: 8,
            },
          });
        const first = await make(),
          second = await make();
        try {
          first.setTimeState({ tsc: 100n, tscAux: AUX });
          second.setTimeState({ tsc: 900n, tscAux: 9 });
          for (const [index, context] of [a, b, a, b, a].entries()) {
            first.setContext(context);
            first.setState(initial(index % 2 ? 0x2000n : ENTRY));
            const result = await first.run({ budget: 2n });
            equal(result.retired, 2n, 'each literal aliased trace retires two');
            equal(sample(first), 101n + BigInt(index * 2), 'aliased context ABA live sample');
            time(first, 102n + BigInt(index * 2));
            time(second, 900n, 9);
          }
          first.setMappings([]);
          first.removeBacking('code');
          first.addBacking({ id: 'code', bytes });
          first.setMappings(mappings);
          first.setState(initial());
          await first.run({ budget: 2n });
          equal(sample(first), 111n, 'same-name backing reincarnation has live time');
          time(first, 112n);
        } finally {
          first.dispose();
          second.dispose();
        }
      },
    },
  ];
}
