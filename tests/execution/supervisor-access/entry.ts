import { createCpu } from '../../../host/index.js';
import {
  AC,
  AUX,
  PC,
  SMEP,
  SMAP,
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

export function supervisorEntryScenarios(compiler: WebAssembly.Module): Scenario[] {
  const side = { createCpu, compiler };
  return [
    {
      name: 'supervisor protected INT commits its frame and preserved AC before a user handler SMEP fetch fault',
      async run() {
        for (const ac of [false, true])
          for (const gate of ['none', 'budget', 'stop'] as const) {
            const f = fixture(side, 'non-pae', 'cd40');
            f.paging.cr4 |= SMEP | SMAP;
            f.leaf(0x4000, 0x9067n);
            f.bytes.set(hex('00400800008e0000'), 0xc200);
            f.bytes[0x9000] = 0x90;
            await using(side, f, async (cpu) => {
              const before = state(0x202n | (ac ? AC : 0n));
              cpu.setState(before);
              cpu.setTimeState({ tsc: 100n, tscAux: AUX });
              const numeric = preserved(cpu),
                context = cpu.readContext(),
                handler = structuredClone(before),
                expectedRam = f.bytes.slice();
              handler.rip = 0x4000n;
              handler.flags = 2n | (ac ? AC : 0n);
              handler.registers[4] = 0x9fe4n;
              for (const [at, value] of [
                [0xdfe4, PC + 2n],
                [0xdfe8, 8n],
                [0xdfec, before.flags],
              ] as const)
                put(expectedRam, at, value!, 4);
              let retired = 0n;
              if (gate !== 'none') {
                const entered = await cpu.run({
                  budget: gate === 'budget' ? 1n : 2n,
                  ...(gate === 'stop' ? { stop: 0x4000n } : {}),
                });
                same(entered.reason, gate, 'handler fetch waits behind admitted work gate');
                same(entered.retired, 1n, 'INT completes before target source acquisition');
                same(entered.state, handler, 'entry complete scalar and preserved AC');
                same(entered.pageFault, undefined, 'entry itself does not check handler fetch');
                same(cpu.readPagingState(), f.paging, 'entry retains old CR2');
                same(
                  cpu.readTimeState(),
                  { tsc: 101n, tscAux: AUX },
                  'entry instruction ticks once',
                );
                memory(cpu, expectedRam, 'entry commits exactly one full interrupt frame');
                retired += entered.retired;
              }
              const denied = await cpu.run({ budget: gate === 'none' ? 2n : 1n });
              retired += denied.retired;
              same(denied.reason, 'page-fault', 'user handler source is denied by SMEP');
              same(retired, 1n, 'only completed INT retires');
              same(denied.state, handler, 'handler fetch denial preserves committed entry');
              same(
                denied.pageFault,
                {
                  vector: 14,
                  address: 0x4000n,
                  access: 'execute',
                  errorCode: 17,
                  instructionPc: 0x4000n,
                },
                'handler fetch exact PF11 independent of AC',
              );
              same(
                cpu.readPagingState(),
                { ...f.paging, cr2: 0x4000n },
                'handler fetch changes only CR2 in the control bank',
              );
              same(cpu.readContext(), context, 'same CPL entry retains exact cached context');
              same(
                cpu.readTimeState(),
                { tsc: 101n, tscAux: AUX },
                'handler fetch adds no guest tick',
              );
              memory(cpu, expectedRam, 'denied handler leaves completed frame and all RAM intact');
              const retry = await cpu.run({ budget: 1n });
              same(retry.reason, 'page-fault', 'handler retry remains a source refusal');
              same(retry.retired, 0n, 'handler retry never executes INT again');
              same(retry.state, handler, 'handler retry never pushes another frame');
              same(
                retry.pageFault,
                denied.pageFault,
                'handler retry retains the exact fault source',
              );
              same(cpu.readTimeState(), { tsc: 101n, tscAux: AUX }, 'handler retry adds no tick');
              memory(cpu, expectedRam, 'handler retry frame bytes and guards');
              numeric();
            });
          }
      },
    },
    {
      name: 'supervisor user IDT denies implicit reads with AC1 and secondary PF folds to DF then bounded shutdown',
      async run() {
        for (const allowances of [[2], [1, 1]]) {
          const f = fixture(side, 'non-pae', 'cd40');
          f.paging.cr4 |= SMAP;
          f.leaf(0x8000, 0xc067n);
          for (const vector of [8, 14, 0x40])
            f.bytes.set(hex('00400800008e0000'), 0xc000 + vector * 8);
          await using(side, f, async (cpu) => {
            const before = state(0x202n | AC);
            cpu.setState(before);
            cpu.setTimeState({ tsc: 100n, tscAux: AUX });
            const numeric = preserved(cpu),
              context = cpu.readContext(),
              reported = await cpu.run({ budget: 1n });
            same(reported.reason, 'page-fault', 'implicit IDT read ignores AC override');
            same(reported.retired, 0n, 'failed software INT never retires');
            same(reported.state, before, 'failed IDT read installs no entry state');
            same(
              reported.pageFault,
              {
                vector: 14,
                address: 0x8200n,
                access: 'read',
                errorCode: 1,
                table: 'idt',
                systemPhase: 'gate-read',
                referenceVector: 0x40,
                instructionPc: PC,
              },
              'implicit IDT exact supervisor PF1 and vector provenance',
            );
            same(cpu.readPagingState(), { ...f.paging, cr2: 0x8200n }, 'IDT report exact CR2');
            memory(cpu, f.bytes, 'failed IDT read has no descriptor or frame payload');
            const staged = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
            const pending = {
              ...before,
              event: {
                kind: 'pending',
                exception: {
                  vector: 14,
                  instructionPc: PC,
                  returnPc: PC,
                  savedFlags: 0x10202n | AC,
                  errorCode: 1,
                  pageFaultAddress: 0x8200n,
                },
              },
            };
            same(staged.reason, 'event-budget', 'initial PF source waits before delivery');
            same(staged.retired, 0n, 'initial PF adds no retirement');
            same(staged.deliveryAttempts, 0n, 'zero allowance makes no entry attempt');
            same(staged.state, pending, 'full frozen primary IDT PF source');
            const omitted = await cpu.run({ budget: 1n });
            same(
              omitted.reason,
              'pending-exception',
              'omitted delivery policy keeps source pending',
            );
            same(omitted.state, pending, 'omitted policy preserves frozen fault and live AC');
            let attempts = 0n;
            for (const allowance of allowances) {
              const result = await cpu.run({
                budget: 1n,
                eventDelivery: { budget: BigInt(allowance) },
              });
              attempts += result.deliveryAttempts ?? 0n;
              same(result.retired, 0n, 'failed automatic entries have no guest retirement');
              if (attempts === 1n) {
                same(result.reason, 'event-budget', 'secondary metadata PF selects pending DF');
                same(
                  result.state,
                  {
                    ...before,
                    event: {
                      kind: 'pending',
                      exception: {
                        vector: 8,
                        instructionPc: PC,
                        returnPc: PC,
                        savedFlags: 0x10202n | AC,
                        errorCode: 0,
                      },
                    },
                  },
                  'full DF source drops obsolete PF address and uses literal error0',
                );
                same(
                  cpu.readPagingState(),
                  { ...f.paging, cr2: 0x8070n },
                  'secondary PF gate14 metadata address replaces CR2',
                );
              } else {
                same(attempts, 2n, 'only primary PF and DF entry are attempted');
                same(result.reason, 'shutdown', 'DF implicit metadata PF reaches shutdown');
                same(
                  result.state,
                  { ...before, event: { kind: 'shutdown' } },
                  'shutdown drops pending source',
                );
                same(
                  cpu.readPagingState(),
                  { ...f.paging, cr2: 0x8040n },
                  'DF gate8 denial installs its own current CR2',
                );
              }
              same(cpu.readContext(), context, 'failed entries preserve all cached context');
              same(
                cpu.readTimeState(),
                { tsc: 100n, tscAux: AUX },
                'entry attempts add no guest tick',
              );
              memory(
                cpu,
                f.bytes,
                'secondary denial publishes no partial frame or descriptor writes',
              );
              numeric();
            }
            same(attempts, 2n, 'delivery partition does not change bounded attempt count');
          });
        }
      },
    },
  ];
}
