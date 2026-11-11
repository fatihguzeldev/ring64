import { equal, hex, physicalCpu, resetContext, RESET_BANK, type Scenario } from './fixture.js';
import type { Cpu, MemoryMapping } from '../../../host/index.js';
const encode = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) => {
    if (typeof v === 'bigint') return v.toString(16);
    if (v && typeof v === 'object' && !Array.isArray(v))
      return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)));
    return v;
  });
function rejects(action: () => unknown, label: string) {
  let threw = false;
  try {
    action();
  } catch {
    threw = true;
  }
  equal(threw, true, label);
}
function checkReset(cpu: Cpu) {
  const state = cpu.readState(),
    registers = Array<bigint>(16).fill(0n);
  registers[2] = 0x600n;
  equal(encode(state.registers), encode(registers), 'reset GPR including upper banks');
  equal(state.rip, 0xfff0n, 'reset logical IP');
  equal(state.flags, 2n, 'reset FLAGS');
  equal(encode(state.interruptibility), encode({ sti: false, ss: false }), 'reset shadows');
  equal(encode(cpu.readPagingState()), encode(RESET_BANK), 'reset controls');
  equal(encode(cpu.readContext()), encode(resetContext()), 'complete literal reset caches');
  equal(encode(cpu.readXmmState()), encode(Array<bigint>(16).fill(0n)), 'reset XMM');
  equal(cpu.readMxcsr(), 0x1f80, 'reset MXCSR');
  const x87 = cpu.readX87State();
  equal(x87.controlWord, 0x40, 'reset differs from FINIT');
  equal(x87.statusWord, 0, 'reset status');
  equal(x87.tagWord, 0x5555, 'reset zero tags');
  equal(encode(x87.registers), encode(Array<bigint>(8).fill(0n)), 'reset raw zeros');
  equal(x87.instructionPointer | x87.dataPointer | BigInt(x87.opcode), 0n, 'reset x87 metadata');
  equal(
    encode(cpu.readDebugState()),
    encode({ addresses: [0n, 0n, 0n, 0n], dr6: 0xffff0ff0n, dr7: 0x400n }),
    'reset debug bank',
  );
  equal(
    Object.values(cpu.readFastSystemState()).every((v) => v === 0n),
    true,
    'reset selected MSRs',
  );
  equal(cpu.inspectTranslations().length, 0, 'reset logical cache');
}
export function lifecycleScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'physical reset clears every literal bank and cache while preserving physical bytes',
      async run() {
        const ram = new Uint8Array(0x10000),
          rom = new Uint8Array(0x10000);
        ram[0x1234] = 0xa5;
        rom.set(hex('90d9e8d9d0dbe2dbe3d9e8'), 0xfff0);
        const cpu = await physicalCpu(compiler, ram, rom);
        try {
          cpu.setState({
            registers: Array<bigint>(16).fill(0xdeadbeef00000000n),
            flags: 0x202n,
            rip: 0xfff0n,
            interruptibility: { sti: false, ss: true },
          });
          cpu.setXmmState(Array<bigint>(16).fill((1n << 127n) + 3n));
          cpu.setMxcsr(0xffff);
          cpu.setDebugState({ addresses: [1n, 2n, 3n, 4n], dr6: 0x600fn, dr7: 0x400n });
          cpu.setFastSystemState({
            star: 0x13000800000000n,
            lstar: 0x2000n,
            fmask: 0x200n,
            sysenterCs: 8n,
            sysenterEip: 0x3000n,
            sysenterEsp: 0x4000n,
            kernelGsBase: 0x5000n,
          });
          cpu.requestInterrupt(33);
          cpu.requestNmi();
          cpu.reset();
          checkReset(cpu);
          equal(cpu.readPhysicalMemory(0x1234n, 1)[0], 0xa5, 'RAM survives');
          equal(cpu.readPhysicalMemory(0xfffffff0n, 1)[0], 0x90, 'ROM survives');
          await cpu.run({ budget: 1n });
          equal(cpu.inspectTranslations().length > 0, true, 'primed cache');
          cpu.reset();
          checkReset(cpu);
          cpu.setState({ ...cpu.readState(), rip: 0xfff1n });
          const push = await cpu.run({ budget: 1n });
          equal(push.retired, 1n, 'reset stack-overflow producer retires');
          equal(cpu.readX87State().statusWord, 0x82c1, 'reset occupied zero tags overflow');
          const pending = await cpu.run({ budget: 1n });
          equal(pending.reason, 'unsupported', 'NE0 pending frontier');
          equal(pending.retired, 0n, 'no pending retirement');
          equal(pending.x87Exception, undefined, 'no synthetic MF');
          cpu.setState({ ...cpu.readState(), rip: 0xfff5n });
          await cpu.run({ budget: 1n });
          equal(cpu.readX87State().statusWord, 0x200, 'FNCLEX repairs exception bits');
          cpu.setState({ ...cpu.readState(), rip: 0xfff7n });
          await cpu.run({ budget: 2n });
          equal(cpu.readX87State().controlWord, 0x37f, 'FNINIT defaults');
          equal(cpu.readX87State().statusWord, 0x3800, 'post-FNINIT push');
        } finally {
          cpu.dispose();
        }
      },
    },
    {
      name: 'successful reset from every capture getter invalidates only the stale outer operation',
      async run() {
        const ram = new Uint8Array(0x10000),
          rom = new Uint8Array(0x10000);
        rom[0xfff0] = 0x90;
        const cpu = await physicalCpu(compiler, ram, rom);
        try {
          const reset = () => {
            cpu.reset();
            return 0n;
          };
          const cases: Array<[string, () => unknown]> = [
            [
              'scalar',
              () =>
                cpu.setState({
                  get registers() {
                    reset();
                    return Array<bigint>(16).fill(9n);
                  },
                  flags: 2n,
                  rip: 0n,
                }),
            ],
            [
              'debug',
              () =>
                cpu.setDebugState({
                  get addresses() {
                    reset();
                    return [1n, 2n, 3n, 4n];
                  },
                  dr6: 0n,
                  dr7: 0x400n,
                }),
            ],
            [
              'controls',
              () =>
                cpu.setPagingState({
                  get cr0() {
                    reset();
                    return 0x60000010n;
                  },
                  cr2: 4n,
                  cr3: 0n,
                  cr4: 0n,
                  efer: 0n,
                }),
            ],
            [
              'MSRs',
              () =>
                cpu.setFastSystemState({
                  get star() {
                    return reset();
                  },
                  lstar: 0n,
                  fmask: 0n,
                  sysenterCs: 0n,
                  sysenterEip: 0n,
                  sysenterEsp: 0n,
                  kernelGsBase: 0n,
                }),
            ],
            [
              'context',
              () =>
                cpu.setContext({
                  ...resetContext(),
                  get cpl() {
                    reset();
                    return 0;
                  },
                }),
            ],
            [
              'XMM',
              () => {
                const bank = Array<bigint>(16).fill(1n);
                Object.defineProperty(bank, '5', {
                  get() {
                    return reset();
                  },
                });
                cpu.setXmmState(bank);
              },
            ],
            [
              'x87',
              () =>
                cpu.setX87State({
                  ...cpu.readX87State(),
                  get controlWord() {
                    reset();
                    return 0x37f;
                  },
                }),
            ],
            [
              'backing',
              () =>
                cpu.addBacking({
                  get id() {
                    reset();
                    return 'new';
                  },
                  bytes: new Uint8Array(1),
                }),
            ],
            [
              'mapping',
              () => {
                const map: MemoryMapping = {
                  get base() {
                    return reset();
                  },
                  backing: 'ram',
                  offset: 0,
                  length: ram.length,
                  permissions: { read: true, write: true, execute: true },
                };
                cpu.setMappings([map]);
              },
            ],
            [
              'bytes',
              () => {
                const bytes = new Proxy(new Uint8Array([7]), {
                  get(target, key) {
                    if (key === Symbol.iterator) reset();
                    const value: unknown = Reflect.get(target, key, target);
                    return typeof value === 'function' ? value.bind(target) : value;
                  },
                });
                cpu.writePhysicalMemory(0x1234n, bytes);
              },
            ],
          ];
          for (const [label, action] of cases) {
            rejects(action, 'stale ' + label + ' capture');
            checkReset(cpu);
          }
          let rejected = false;
          try {
            await cpu.run({
              get budget() {
                cpu.reset();
                return 1n;
              },
            });
          } catch {
            rejected = true;
          }
          equal(rejected, true, 'stale run getter');
          checkReset(cpu);
          // Ordinary idle nesting has no reset authority and retains predecessor policy.
          cpu.setState({
            get registers() {
              cpu.setMxcsr(0x1f80);
              return Array<bigint>(16).fill(0n);
            },
            flags: 2n,
            rip: 0xfff0n,
          });
          equal(cpu.readState().rip, 0xfff0n, 'nested ordinary setter stays accepted');
        } finally {
          cpu.dispose();
          rejects(() => cpu.reset(), 'disposed reset');
        }
      },
    },
    {
      name: 'reset during awaited generated compilation refuses without cancelling the valid run',
      async run() {
        const cpu = await physicalCpu(
          compiler,
          new Uint8Array(0x10000),
          Uint8Array.from({ length: 0x10000 }, (_, i) => (i === 0xfff0 ? 0x90 : 0)),
        );
        const original = WebAssembly.compile;
        let release: (() => void) | undefined;
        let began: (() => void) | undefined;
        const started = new Promise<void>((r) => (began = r)),
          gate = new Promise<void>((r) => (release = r));
        WebAssembly.compile = async (bytes) => {
          began!();
          await gate;
          return original(bytes);
        };
        try {
          const pending = cpu.run({ budget: 1n });
          await started;
          rejects(() => cpu.reset(), 'busy reset');
          release!();
          const result = await pending;
          equal(result.retired, 1n, 'run survives rejected reset');
          cpu.reset();
          checkReset(cpu);
        } finally {
          WebAssembly.compile = original;
          release?.();
          cpu.dispose();
        }
      },
    },
    {
      name: 'reset retains the captured I/O receiver methods and rejects callbacks without cancelling their effect',
      async run() {
        const rom = new Uint8Array(0x10000);
        rom.set(hex('e480'), 0xfff0);
        let calls = 0;
        let cpu: Cpu;
        const io = {
          marker: 17,
          read(this: { marker: number }, port: number, width: number) {
            equal(this.marker, 17, 'captured receiver');
            equal(port, 0x80, 'reset IN port');
            equal(width, 8, 'reset IN width');
            calls++;
            rejects(() => cpu.reset(), 'callback busy reset');
            return 0x5a;
          },
          write() {
            throw new Error('unexpected OUT');
          },
        };
        cpu = await physicalCpu(
          compiler,
          new Uint8Array(0x10000),
          rom,
          RESET_BANK,
          resetContext(),
          { io },
        );
        try {
          io.read = () => {
            throw new Error('replacement method must not be captured');
          };
          for (let i = 0; i < 3; i++) {
            cpu.reset();
            equal(calls, i, 'reset has no provider effect');
            const result = await cpu.run({ budget: 1n });
            equal(result.retired, 1n, 'IN after reset');
            equal(result.state.registers[0], 0x5an, 'captured input');
            equal(calls, i + 1, 'one provider call');
          }
        } finally {
          cpu.dispose();
        }
      },
    },
  ];
}
