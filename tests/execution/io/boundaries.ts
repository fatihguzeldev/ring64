import { createCpu, type IoProvider } from '../../../host/index.js';
import {
  LIMITS,
  equal,
  hex,
  initial,
  memory,
  check,
  type Scenario,
} from '../../support/fixture.js';
import { snapshot } from '../far-control/fixture.js';

export function ioBoundaryScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'each REP input rechecks a live bitmap which its preceding store can deny',
      async run() {
        const context = snapshot('protected', 3);
        context.tr = { selector: 0x28, valid: true, base: 0x8000n, limit: 0x81, attributes: 0x8b };
        const ram = new Uint8Array(0x82);
        ram[0x66] = 0x80;
        ram[0x81] = 0xff;
        const inputs = [0x80, 0xaa];
        let calls = 0;
        const cpu = await createCpu({
          compiler,
          limits: LIMITS,
          context,
          code: { base: 0x1000n, bytes: hex('f36c') },
          ram: { base: 0x8000n, bytes: ram },
          io: {
            read() {
              return inputs[calls++]!;
            },
            write() {},
          },
        });
        try {
          cpu.setState(initial(0x1000n, { 1: 2n, 2: 7n, 7: 0x8080n }));
          const first = await cpu.run({ budget: 1n, repeatBudget: 2n });
          equal(first.reason, 'protection-fault', 'second element denied');
          equal(first.protectionFault?.vector, 13, 'I/O #GP');
          equal(first.protectionFault?.errorCode, 0, 'no selector error code');
          equal(first.protectionFault?.phase, 'privilege', 'permission owner');
          equal(first.state.registers[1], 1n, 'completed count retained');
          equal(first.state.registers[7], 0x8081n, 'completed index retained');
          equal(first.repeatIterations, 1n, 'one committed element');
          equal(first.retired, 0n, 'unfinished REP');
          equal(calls, 1, 'denial precedes second callback');
          memory(cpu, 0x8080n, '80ff');
          cpu.writeMemory(0x8080n, hex('00'));
          const last = await cpu.run({ budget: 1n, repeatBudget: 1n });
          equal(last.reason, 'budget', 'repaired bitmap admits remainder');
          equal(calls, 2, 'no prior callback replay');
          memory(cpu, 0x8080n, '00aa');
        } finally {
          cpu.dispose();
        }
      },
    },
    {
      name: 'I/O permission failure precedes missing provider and operand geometry, while bypass reads no TSS',
      async run() {
        const context = snapshot('long64', 3);
        const cpu = await createCpu({
          compiler,
          limits: LIMITS,
          context,
          code: { base: 0x1000n, bytes: hex('6e') },
          ram: { base: 0x4000n, bytes: new Uint8Array(1) },
        });
        try {
          cpu.setState(initial(0x1000n, { 2: 0x80n, 6: 0x800000000000n }, 0x10002n));
          const denied = await cpu.run({ budget: 1n });
          equal(denied.reason, 'protection-fault', 'invalid TR selects permission fault');
          equal(denied.protectionFault?.vector, 13, 'permission #GP rather than #TS');
          equal(denied.state.flags, 2n, 'I/O permission is after ordinary begin');
          cpu.setState(initial(0x1000n, { 2: 0x80n, 6: 0x800000000000n }, 0x13002n));
          const absent = await cpu.run({ budget: 1n });
          equal(
            absent.reason,
            'unsupported',
            'IOPL bypass reaches missing provider before operand',
          );
          equal(absent.state.flags, 0x3002n, 'no provider is after begin');
          equal(absent.fault, undefined, 'operand not touched');
        } finally {
          cpu.dispose();
        }
      },
    },
    {
      name: 'input source overwrite refetches the new form after inherited repeat-budget priority',
      async run() {
        const inputs = [0x6c, 0x7b];
        let calls = 0;
        const cpu = await createCpu({
          compiler,
          limits: LIMITS,
          entry: 0x1000n,
          memoryLimits: { maxBackingBytes: 3, maxBackings: 1, maxMappings: 2 },
          memory: {
            backings: [{ id: 'code', bytes: hex('f36cf5') }],
            mappings: [
              {
                base: 0x1000n,
                backing: 'code',
                offset: 0,
                length: 3,
                permissions: { read: true, write: false, execute: true },
              },
              {
                base: 0x2000n,
                backing: 'code',
                offset: 0,
                length: 3,
                permissions: { read: true, write: true, execute: false },
              },
            ],
          },
          io: {
            read() {
              return inputs[calls++]!;
            },
            write() {},
          },
        });
        try {
          cpu.setState(initial(0x1000n, { 1: 2n, 2: 0x80n, 7: 0x2000n }));
          const first = await cpu.run({ budget: 1n, repeatBudget: 1n });
          equal(first.reason, 'repeat-budget', 'allowance precedes redispatch');
          equal(calls, 1, 'one completed input');
          equal(first.state.rip, 0x1000n, 'partial instruction boundary');
          equal(first.state.registers[1], 1n, 'one remaining');
          equal(first.state.registers[7], 0x2001n, 'first store index');
          memory(cpu, 0x1000n, '6c6cf5');
          const last = await cpu.run({ budget: 1n, repeatBudget: 0n });
          equal(last.reason, 'budget', 'new bare form ignores repeat allowance');
          equal(calls, 2, 'no input replay');
          equal(last.state.rip, 0x1001n, 'bare byte length');
          equal(last.state.registers[1], 1n, 'bare count unchanged');
          equal(last.repeatIterations, 0n, 'bare not charged');
          memory(cpu, 0x1000n, '6c7bf5');
        } finally {
          cpu.dispose();
        }
      },
    },
    {
      name: 'provider failures are terminal and never inspect thenables or expose a retry checkpoint',
      async run() {
        for (const failure of ['throw', 'invalid-read', 'invalid-write'] as const) {
          let calls = 0,
            thenReads = 0;
          const malformed = {
            get then() {
              thenReads++;
              throw new Error('then must not be read');
            },
          };
          const io: IoProvider = {
            read() {
              calls++;
              if (failure === 'throw') throw new Error('external effect already happened');
              return malformed as unknown as number;
            },
            write() {
              calls++;
              return malformed as unknown as void;
            },
          };
          const cpu = await createCpu({
            compiler,
            limits: LIMITS,
            io,
            code: { base: 0x1000n, bytes: hex(failure === 'invalid-write' ? 'ee' : 'ec') },
            ram: { base: 0x4000n, bytes: new Uint8Array(1) },
          });
          let rejected = false;
          try {
            await cpu.run({ budget: 1n });
          } catch {
            rejected = true;
          }
          check(rejected, 'callback failure rejects run');
          equal(calls, 1, 'one uncertain effect, never replayed');
          equal(thenReads, 0, 'no thenable inspection');
          for (const action of [
            () => cpu.readState(),
            () => cpu.readContext(),
            () => cpu.setState(initial()),
          ]) {
            let failed = false;
            try {
              action();
            } catch {
              failed = true;
            }
            check(failed, 'failed CPU rejects administration');
          }
          rejected = false;
          try {
            await cpu.run({ budget: 1n });
          } catch {
            rejected = true;
          }
          check(rejected, 'failed CPU cannot retry');
          equal(calls, 1, 'no new callback after failure');
          cpu.dispose();
        }
      },
    },
    {
      name: 'caught same-CPU reentry preserves a valid synchronous I/O transaction',
      async run() {
        let calls = 0,
          rejected = 0;
        const promises: Promise<unknown>[] = [];
        const cpu = await createCpu({
          compiler,
          limits: LIMITS,
          code: { base: 0x1000n, bytes: hex('ec') },
          ram: { base: 0x4000n, bytes: new Uint8Array(1) },
          io: {
            read() {
              calls++;
              for (const action of [
                () => cpu.readState(),
                () => cpu.dispose(),
                () => cpu.requestNmi(),
              ]) {
                try {
                  action();
                } catch {
                  rejected++;
                }
              }
              promises.push(cpu.run({ budget: 1n }).catch(() => rejected++));
              return 0xab;
            },
            write() {},
          },
        });
        try {
          const result = await cpu.run({ budget: 1n });
          await Promise.all(promises);
          equal(result.reason, 'budget', 'caught errors do not poison outer run');
          equal(result.state.registers[0], 0xabn, 'valid returned input');
          equal(calls, 1, 'one input');
          equal(rejected, 4, 'all same-CPU operations rejected');
        } finally {
          cpu.dispose();
        }
      },
    },
  ];
}
