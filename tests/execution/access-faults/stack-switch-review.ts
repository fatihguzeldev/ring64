import {
  using,
  snapshot,
  initial,
  loadedCode,
  loadedData,
  withGate,
  gate,
  CODE32,
  DATA32,
  STACK,
  FILL,
  same,
  equal,
  type Scenario,
} from '../exception-delivery/fixture.js';
import { TSS } from '../software-events/fixture.js';

function execution(switching: boolean) {
  const context = snapshot('protected', switching ? 3 : 0);
  context.segments.cs = loadedCode(32, switching ? 0x1b : 8, switching ? 3 : 0);
  context.segments.ss = loadedData(32, switching ? 0x23 : 16, switching ? 3 : 0);
  if (switching) context.tr = { ...TSS };
  else context.segments.ss.limit = 0x7ff7;
  return context;
}

function data(address: bigint, dpl: number, switching: boolean) {
  return [
    {
      base: 0x4008n,
      bytes: CODE32 + 'f77f000000934000' + CODE32.replace('9b', 'fb') + DATA32.replace('93', 'f3'),
    },
    { base: address, bytes: gate(32, 8, 0x2000n, dpl) },
    ...(switching ? [{ base: 0x5004n, bytes: '008000001000' }] : []),
    { base: STACK, bytes: FILL },
    { base: 0x6f00n, bytes: 'd5'.repeat(256) },
  ];
}

export function stackSwitchReviewScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'architectural access reviewed software stack-switch limit preserves inherited report diagnostics',
      async run() {
        for (const switching of [false, true]) {
          const context = execution(switching);
          const address = withGate(context, 0x20);
          await using(
            compiler,
            'cd20',
            context,
            async (cpu) => {
              cpu.setState(initial(0x1000n, { 4: switching ? 0x7000n : 0x8000n }, 0x202n));
              const before = cpu.readState();
              const report = await cpu.run({ budget: 1n });
              equal(
                report.reason,
                'segment-fault',
                'software entry report remains a segment refusal',
              );
              equal(report.segmentFault?.segment, 'ss', 'selected handler stack');
              equal(report.segmentFault?.cause, 'limit', 'exact selected cause');
              equal(report.segmentFault?.failingOffset, 0x7ffcn, 'first failing frame slot');
              equal(report.retired, 0n, 'failed software INT is unretired');
              same(
                report.state,
                before,
                'no source scalar or event publication on failed report entry',
              );
              same(cpu.readContext(), context, 'prepared handler context never commits');
              same(
                cpu.readMemory(STACK, 256),
                new Uint8Array(256).fill(0xa5),
                'new stack atomicity',
              );
              same(
                cpu.readMemory(0x6f00n, 256),
                new Uint8Array(256).fill(0xd5),
                'old stack untouched',
              );
            },
            { data: data(address, 3, switching) },
          );
        }
      },
    },
    {
      name: 'architectural access reviewed new-stack SS selects NewSS and EXT while same-stack SS stays zero',
      async run() {
        for (const source of ['software', 'int1', 'irq', 'ud', 'gp'] as const)
          for (const switching of [false, true]) {
            const context = execution(switching);
            const vector =
              source === 'int1' ? 1 : source === 'ud' ? 6 : source === 'gp' ? 13 : 0x20;
            const address = withGate(context, vector);
            const software = source === 'software' || source === 'int1';
            await using(
              compiler,
              source === 'software'
                ? 'cd20'
                : source === 'int1'
                  ? 'f1'
                  : source === 'ud'
                    ? 'f090'
                    : source === 'gp'
                      ? '0f2803'
                      : '90',
              context,
              async (cpu) => {
                cpu.setState(
                  initial(0x1000n, { 3: 0x6001n, 4: switching ? 0x7000n : 0x8000n }, 0x202n),
                );
                const before = cpu.readState();
                if (source === 'irq') cpu.requestInterrupt(0x20);
                const fault = await cpu.run({
                  budget: 1n,
                  eventDelivery: { budget: software ? 0n : 1n },
                });
                equal(fault.reason, 'event-budget', `${source} bounded selected failure`);
                equal(fault.retired, 0n, `${source} never retires a failed source`);
                equal(
                  fault.deliveryAttempts,
                  software ? 0n : 1n,
                  `${source} exact entry attempt count`,
                );
                same(
                  fault.state.event,
                  {
                    kind: 'pending',
                    exception: {
                      vector: source === 'gp' ? 8 : 12,
                      instructionPc: 0x1000n,
                      returnPc: 0x1000n,
                      savedFlags: 0x10202n,
                      errorCode:
                        source === 'gp' || !switching ? 0 : source !== 'software' ? 0x11 : 0x10,
                    },
                  },
                  `${source} ${switching ? 'new-stack selector and source EXT' : 'ordinary same-stack zero'} or contributory DF`,
                );
                same(fault.state.registers, before.registers, 'no source or handler SP commit');
                equal(fault.state.flags, 0x202n, 'live source flags unchanged');
                same(cpu.readContext(), context, 'failed prepared context never commits');
                same(
                  cpu.readMemory(STACK, 256),
                  new Uint8Array(256).fill(0xa5),
                  'no half new frame',
                );
                same(
                  cpu.readMemory(0x6f00n, 256),
                  new Uint8Array(256).fill(0xd5),
                  'old stack untouched',
                );
              },
              { data: data(address, source === 'software' ? 3 : 0, switching) },
            );
          }
      },
    },
  ];
}
