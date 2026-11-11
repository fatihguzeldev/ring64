import { createCpu, type IoProvider } from '../../../host/index.js';
import { LIMITS, check, equal, hex, initial, type Scenario } from '../../support/fixture.js';
import { same } from '../far-control/fixture.js';

export function ioLifecycleReviewScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'provider option and callable getters are captured once before construction awaits and premature imports stay inert',
      async run() {
        const instantiate = WebAssembly.instantiate;
        let optionGets = 0,
          readGets = 0,
          writeGets = 0,
          reads = 0,
          writes = 0,
          premature = 0,
          crossed = false;
        const receiver = {
          value: 0x17,
          get read() {
            readGets++;
            return function (this: { value: number }) {
              equal(this, receiver, 'original read receiver');
              reads++;
              return this.value;
            };
          },
          get write() {
            writeGets++;
            return function (
              this: { value: number },
              _port: number,
              _width: number,
              value: number,
            ) {
              equal(this, receiver, 'original write receiver');
              writes++;
              this.value = value;
            };
          },
        };
        WebAssembly.instantiate = (async (
          module: WebAssembly.Module,
          imports?: WebAssembly.Imports,
        ) => {
          if (!crossed) {
            crossed = true;
            const read = imports?.io?.read;
            check(typeof read === 'function', 'fixed Core read import');
            try {
              Reflect.apply(read, undefined, [0x80, 8]);
            } catch (error) {
              check(String(error).includes('outside a reached I/O effect'), 'construction guard');
              premature++;
            }
            receiver.value = 0x2b;
            Object.defineProperty(receiver, 'read', {
              value: () => {
                throw Error('replacement read');
              },
            });
            Object.defineProperty(receiver, 'write', {
              value: () => {
                throw Error('replacement write');
              },
            });
          }
          return instantiate(module, imports);
        }) as typeof WebAssembly.instantiate;
        let cpu: Awaited<ReturnType<typeof createCpu>> | undefined;
        try {
          cpu = await createCpu({
            compiler,
            limits: LIMITS,
            code: { base: 0x1000n, bytes: hex('ecee') },
            ram: { base: 0x4000n, bytes: new Uint8Array(1) },
            get io() {
              optionGets++;
              return receiver;
            },
          });
          same(
            [optionGets, readGets, writeGets, premature, reads, writes],
            [1, 1, 1, 1, 0, 0],
            'construction capture and no effect',
          );
          cpu.setState(initial(0x1000n, { 2: 0x80n }));
          const result = await cpu.run({ budget: 2n });
          equal(result.retired, 2n, 'captured functions execute normally');
          equal(
            result.state.registers[0]! & 255n,
            0x2bn,
            'live receiver data with original method',
          );
          same(
            [optionGets, readGets, writeGets, reads, writes],
            [1, 1, 1, 1, 1],
            'no recapture after await',
          );
        } finally {
          WebAssembly.instantiate = instantiate;
          cpu?.dispose();
        }
      },
    },
    {
      name: 'a generated instantiation cannot invoke native port effects before the execution scope',
      async run() {
        let calls = 0,
          attempts = 0;
        const cpu = await createCpu({
          compiler,
          limits: LIMITS,
          code: { base: 0x1000n, bytes: hex('ec') },
          ram: { base: 0x4000n, bytes: new Uint8Array(1) },
          io: {
            read() {
              calls++;
              return 0x7b;
            },
            write() {
              calls++;
            },
          },
        });
        const Instance = WebAssembly.Instance;
        WebAssembly.Instance = class extends Instance {
          constructor(module: WebAssembly.Module, imports?: WebAssembly.Imports) {
            const effect = imports?.env?.io;
            check(typeof effect === 'function', 'generated IO adapter');
            attempts++;
            Reflect.apply(effect, undefined, [4, 0x80, 0n, 0n, 3, 2n]);
            super(module, imports);
          }
        };
        try {
          cpu.setState(initial(0x1000n, { 2: 0x80n }));
          let failure: unknown;
          try {
            await cpu.run({ budget: 1n });
          } catch (error) {
            failure = error;
          }
          check(failure instanceof Error, 'premature native effect rejects run');
          check(
            String(failure.cause).includes('outside a reached I/O effect'),
            'execution-scope denial owns failure',
          );
          equal(attempts, 1, 'one constructor attempt');
          equal(calls, 0, 'no premature provider invocation');
          let rejected = false;
          try {
            cpu.readState();
          } catch {
            rejected = true;
          }
          check(rejected, 'bridge invariant failure is terminal');
        } finally {
          WebAssembly.Instance = Instance;
          cpu.dispose();
        }
      },
    },
    {
      name: 'a synchronous provider may use an independent warm CPU without borrowing or scope interference',
      async run() {
        const other = await createCpu({
          compiler,
          limits: LIMITS,
          code: { base: 0x1000n, bytes: hex('48ffc0') },
          ram: { base: 0x4000n, bytes: new Uint8Array(1) },
        });
        let cpu: Awaited<ReturnType<typeof createCpu>> | undefined;
        const nested: Promise<unknown>[] = [];
        try {
          other.setState(initial(0x1000n, { 0: 0n }));
          await other.run({ budget: 1n });
          other.setState(initial(0x1000n, { 0: 1n }));
          let calls = 0;
          cpu = await createCpu({
            compiler,
            limits: LIMITS,
            code: { base: 0x1000n, bytes: hex('ec') },
            ram: { base: 0x4000n, bytes: new Uint8Array(1) },
            io: {
              read() {
                calls++;
                nested.push(other.run({ budget: 1n }));
                equal(
                  other.readState().registers[0],
                  2n,
                  'independent warm run finishes during callback',
                );
                other.writeMemory(0x4000n, hex('7b'));
                return other.readMemory(0x4000n, 1)[0]!;
              },
              write() {},
            },
          });
          cpu.setState(initial(0x1000n));
          const result = await cpu.run({ budget: 1n });
          await Promise.all(nested);
          equal(result.reason, 'budget', 'outer effect completes');
          equal(result.state.registers[0]! & 255n, 0x7bn, 'independent result');
          equal(calls, 1, 'one outer input');
        } finally {
          cpu?.dispose();
          other.dispose();
        }
      },
    },
    {
      name: 'code-writing INS publishes its element before PAUSE translation quota and later resumes without another input',
      async run() {
        let calls = 0;
        const io: IoProvider = {
          read() {
            calls++;
            return 0x90;
          },
          write() {
            throw Error('no output');
          },
        };
        const cpu = await createCpu({
          compiler,
          limits: { ...LIMITS, maxTranslationsPerRun: 1, maxInstructions: 1 },
          io,
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
        });
        try {
          const before = initial(0x1000n, { 1: 2n, 2: 0x80n, 7: 0x2001n });
          cpu.setState(before);
          const noBudget = await cpu.run({ budget: 0n });
          equal(noBudget.reason, 'budget', 'entry budget prevents all effects');
          const stopped = await cpu.run({ budget: 1n, stop: 0x1000n });
          equal(stopped.reason, 'stop', 'entry stop prevents all effects');
          equal(calls, 0, 'no provider during entry refusals');
          const first = await cpu.run({ budget: 1n, repeatBudget: 2n });
          equal(first.reason, 'resource-limit', 'only new PAUSE compile is refused');
          equal(first.resources.compilations, 1, 'first REP artifact only');
          equal(first.retired, 0n, 'old REP unfinished');
          equal(first.repeatIterations, 1n, 'completed element accounted');
          equal(first.remainingRepeatBudget, 1n, 'no quota-before-bookkeeping');
          equal(first.state.rip, 0x1000n, 'refetch current changed form');
          equal(first.state.registers[7], 0x2002n, 'committed index');
          equal(first.state.registers[1], 1n, 'committed count');
          equal(calls, 1, 'one uncertain-free effect');
          same(
            Array.from(cpu.readMemory(0x1000n, 3)),
            [0xf3, 0x90, 0xf5],
            'new PAUSE plus guarded tail',
          );
          const last = await cpu.run({ budget: 1n, repeatBudget: 0n });
          equal(last.retired, 1n, 'new PAUSE retires');
          equal(last.state.rip, 0x1002n, 'new length');
          equal(last.repeatIterations, 0n, 'new form does not repeat');
          equal(calls, 1, 'input never replayed');
          equal(last.state.registers[1], 1n, 'no latched REP form');
          equal(last.state.registers[7], 0x2002n, 'no extra destination');
        } finally {
          cpu.dispose();
        }
      },
    },
  ];
}
