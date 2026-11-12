import {
  usingGate,
  initial,
  equal,
  same,
  put,
  SOURCE,
  TARGET,
  GDT,
  TSS,
  RAM_SIZE,
  type Scenario,
} from './fixture.js';

export function gateDebugScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'call gate debug merges explicit pointer old parameters new stack writes and TF once in the destination context',
      async run() {
        for (const tf of [false, true])
          await usingGate(
            compiler,
            {
              family: 'legacy32',
              code: 'ff1b',
              count: 31,
              targetCode: 'ca7c00',
              prepare(memory) {
                put(memory, 0x5000, 0xffffffffn, 4);
                put(memory, 0x5004, 0x3bn, 2);
              },
            },
            async (cpu) => {
              cpu.setDebugState({
                addresses: [0x5004n, 0x4078n, 0x8f74n, TSS + 8n],
                dr6: 0n,
                dr7: 0x7df70455n,
              });
              cpu.setState(initial(SOURCE, { 3: 0x5000n, 4: 0x4000n }, tf ? 0x302n : 0x202n));
              const result = await cpu.run({
                budget: 1n,
                stop: TARGET,
                eventDelivery: { budget: 0n },
              });
              equal(result.reason, 'event-budget', 'one completed DB source outranks stop');
              equal(result.retired, 1n, 'one gate retirement');
              equal(result.state.rip, TARGET, 'resume at transitioned target');
              equal(result.state.registers[4], 0x8f74n, 'all 35 writes completed');
              equal(cpu.readContext().cpl, 0, 'DB boundary has destination CPL');
              same(
                result.state.event,
                {
                  kind: 'pending',
                  exception: {
                    vector: 1,
                    instructionPc: SOURCE,
                    returnPc: TARGET,
                    savedFlags: tf ? 0x302n : 0x202n,
                    debug: {
                      class: 'trap',
                      cause: 'data-breakpoint',
                      breakpoints: 7,
                      singleStep: tf,
                      instructionCompleted: true,
                    },
                  },
                },
                'actual operand spans aggregate without TSS metadata',
              );
              equal(
                cpu.readDebugState().dr6,
                tf ? 0xffff4ff7n : 0xffff0ff7n,
                'exact current instruction status',
              );
            },
          );
      },
    },
    {
      name: 'call gate debug excludes GDT TSS descriptor writes and page metadata while RETF observes its real outer frame reads',
      async run() {
        await usingGate(
          compiler,
          {
            family: 'legacy32',
            count: 3,
            codeAccessed: false,
            stackAccessed: false,
            targetCode: 'ca0c00',
          },
          async (cpu) => {
            cpu.setDebugState({
              addresses: [GDT + 13n, GDT + 21n, TSS + 4n, 0x19000n],
              dr6: 0n,
              dr7: 0xffff0455n,
            });
            cpu.setState(initial(SOURCE, { 4: 0x4000n }));
            const enter = await cpu.run({ budget: 1n });
            equal(enter.reason, 'budget', 'metadata is not an instruction operand');
            equal(cpu.readDebugState().dr6, 0xffff0ff0n, 'no metadata hit');
            cpu.setDebugState({
              addresses: [0x8ff8n, 0x8ffcn, 0x8fecn, 0x4000n],
              dr6: 0n,
              dr7: 0xffff0455n,
            });
            const leave = await cpu.run({ budget: 1n });
            equal(leave.reason, 'debug-exception', 'outer RETF completed read trap');
            equal(
              leave.debugException?.breakpoints,
              3,
              'saved SP SS read but cleanup-gap parameter bytes are not',
            );
            equal(leave.state.rip, 0x1007n, 'caller PC restored before trap');
            equal(leave.state.registers[4], 0x400cn, 'cleanup committed');
            equal(cpu.readContext().cpl, 3, 'RETF trap belongs to caller context');
          },
        );
      },
    },
    {
      name: 'call gate debug faults discard pointer and tentative old parameter hits and a JMP has no fictitious frame writes',
      async run() {
        await usingGate(
          compiler,
          {
            family: 'legacy32',
            code: 'ff1b',
            count: 1,
            prepare(memory) {
              put(memory, 0x5000, 0n, 4);
              put(memory, 0x5004, 0x3bn, 2);
              put(memory, 0x19010, 0x4063n, 4);
            },
          },
          async (cpu) => {
            cpu.setDebugState({
              addresses: [0x5000n, 0x4000n, 0x8ffcn, 0n],
              dr6: 0n,
              dr7: 0x0df30415n,
            });
            cpu.setState(initial(SOURCE, { 3: 0x5000n, 4: 0x4000n }));
            const failed = await cpu.run({ budget: 1n });
            equal(failed.reason, 'page-fault', 'old-CPL parameter read denied');
            equal(failed.pageFault?.errorCode, 5, 'user read of supervisor page');
            equal(failed.retired, 0n, 'failed gate cannot report completion');
            equal(cpu.readDebugState().dr6, 0xffff0ff0n, 'no tentative hit publication');
            equal(
              failed.state.debugContinuation,
              undefined,
              'no partial gate watchpoint checkpoint',
            );
          },
        );
        await usingGate(
          compiler,
          {
            code: 'ff2b',
            count: 31,
            targetCpl: 3,
            prepare(memory, context) {
              context.tr.valid = false;
              put(memory, 0x5000, 0n, 4);
              put(memory, 0x5004, 0x3bn, 2);
            },
          },
          async (cpu) => {
            cpu.setDebugState({
              addresses: [0x5004n, 0x3ffcn, 0x4000n, 0x8ffcn],
              dr6: 0n,
              dr7: 0xddf70455n,
            });
            cpu.setState(initial(SOURCE, { 3: 0x5000n, 4: 0x4000n }));
            const result = await cpu.run({ budget: 1n });
            equal(result.reason, 'debug-exception', 'JMP explicit pointer read');
            equal(result.debugException?.breakpoints, 1, 'no old parameters or stack writes');
            equal(result.state.registers[4], 0x4000n, 'unchanged JMP bank');
          },
        );
      },
    },
    {
      name: 'call gate debug retains SS history across private admission and selected NP cancels it under the inherited fault policy',
      async run() {
        await usingGate(compiler, {}, async (cpu) => {
          const rwx = { read: true, write: true, execute: true };
          cpu.setMappings([
            { base: 0n, backing: 'ram', offset: 0, length: 0x8ff0, permissions: rwx },
            {
              base: 0x8ff0n,
              backing: 'ram',
              offset: 0x8ff0,
              length: 16,
              permissions: { read: true, write: false, execute: false },
            },
            {
              base: 0x9000n,
              backing: 'ram',
              offset: 0x9000,
              length: RAM_SIZE - 0x9000,
              permissions: rwx,
            },
          ]);
          cpu.setState({
            ...initial(SOURCE, { 4: 0x4000n }),
            interruptibility: { sti: false, ss: true },
            debugContinuation: { breakpoints: 8, originPc: 0xff0n },
          });
          const failed = await cpu.run({ budget: 1n });
          equal(failed.reason, 'data-fault', 'private selected-frame permission');
          same(
            failed.state.debugContinuation,
            { breakpoints: 8, originPc: 0xff0n },
            'old deferred cause survives failed gate',
          );
          cpu.setMappings([
            { base: 0n, backing: 'ram', offset: 0, length: RAM_SIZE, permissions: rwx },
          ]);
          const success = await cpu.run({ budget: 1n });
          equal(
            success.reason,
            'debug-exception',
            'history publishes after actual gate completion',
          );
          equal(success.debugException?.breakpoints, 8, 'only historical comparator');
          equal(success.debugException?.deferredOriginPc, 0xff0n, 'historical source stays intact');
          equal(success.state.rip, TARGET, 'current resume is completed destination');
          equal(success.state.debugContinuation, undefined, 'history consumed exactly once');
        });
        await usingGate(compiler, { gatePresent: false }, async (cpu) => {
          cpu.setState({
            ...initial(SOURCE, { 4: 0x4000n }),
            interruptibility: { sti: false, ss: true },
            debugContinuation: { breakpoints: 8, originPc: 0xff0n },
          });
          const fault = await cpu.run({ budget: 1n });
          equal(fault.reason, 'protection-fault', 'recognized NP successor');
          equal(fault.protectionFault?.vector, 11, 'architectural source');
          equal(
            fault.state.debugContinuation,
            undefined,
            'recognized fault cancels old deferred cause',
          );
        });
      },
    },
  ];
}
