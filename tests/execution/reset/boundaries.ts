import {
  createCpu,
  equal,
  hex,
  physicalCpu,
  put,
  resetContext,
  transitionProgram,
  type Scenario,
} from './fixture.js';
import { LIMITS } from '../../support/fixture.js';
function protected32() {
  const c = resetContext();
  c.mode = 'protected';
  c.segments.cs = {
    ...c.segments.cs,
    selector: 8,
    base: 0n,
    default32: true,
    limit: 0xffffffff,
    type: 'readable-code',
  };
  c.segments.ss = { ...c.segments.ss, default32: true, limit: 0xffffffff };
  return c;
}
export function boundaryScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: '69 instruction transition packet resumes at every single-instruction boundary with literal family checkpoints',
      async run() {
        const { ram, rom } = transitionProgram(),
          cpu = await physicalCpu(compiler, ram, rom);
        try {
          cpu.reset();
          const checkpoints = new Map<bigint, [string, bigint, bigint, bigint]>([
            [0x25n, ['protected', 0x33n, 0x608n, 0n]],
            [0x20022n, ['protected', 0x80000033n, 0x608n, 0n]],
            [0x20053n, ['protected', 0x80000033n, 0x628n, 0n]],
            [0x20089n, ['compatibility', 0x80000033n, 0x628n, 0x500n]],
            [0x21000n, ['long64', 0x80000033n, 0x628n, 0x500n]],
            [0x22000n, ['compatibility', 0x80000033n, 0x628n, 0x500n]],
            [0x2200bn, ['protected', 0x33n, 0x628n, 0x100n]],
            [0x230an, ['real', 0x32n, 0x608n, 0n]],
          ]);
          let seen = 0;
          for (let i = 0; i < 69; i++) {
            const result = await cpu.run({ budget: 1n });
            equal(result.reason, 'budget', 'single work boundary ' + i);
            equal(result.retired, 1n, 'no replay ' + i);
            const wanted = checkpoints.get(result.state.rip);
            if (wanted) {
              const p = cpu.readPagingState();
              equal(cpu.readContext().mode, wanted[0], 'mode ' + i);
              equal(p.cr0, wanted[1], 'CR0 ' + i);
              equal(p.cr4, wanted[2], 'CR4 ' + i);
              equal(p.efer, wanted[3], 'EFER ' + i);
              seen++;
            }
          }
          equal(seen, 8, 'every named writer/far checkpoint');
          equal(cpu.readState().rip, 0x403n, 'final IP');
        } finally {
          cpu.dispose();
        }
      },
    },
    {
      name: 'committed PG activation survives a late successor PF and repaired retry executes only the target',
      async run() {
        const ram = new Uint8Array(0x10000);
        ram.set(hex('0f22c0'), 0x1000);
        ram[0x6003] = 0x90;
        put(ram, 0x3000, 0x4003n, 4);
        const cpu = await physicalCpu(
          compiler,
          ram,
          new Uint8Array(0x10000),
          { cr0: 0x33n, cr2: 0xdeadn, cr3: 0x3000n, cr4: 0x608n, efer: 0n },
          protected32(),
        );
        try {
          const registers = Array<bigint>(16).fill(0n);
          registers[0] = 0x80000033n;
          cpu.setState({ registers, flags: 2n, rip: 0x1000n });
          const write = await cpu.run({ budget: 1n });
          equal(write.reason, 'budget', 'completed writer wins budget');
          equal(write.retired, 1n, 'writer once');
          equal(write.state.rip, 0x1003n, 'committed successor');
          equal(cpu.readPagingState().cr0, 0x80000033n, 'PG committed');
          const failure = await cpu.run({ budget: 1n });
          equal(failure.reason, 'page-fault', 'destination fetch fault');
          equal(failure.retired, 0n, 'no writer replay');
          equal(failure.pageFault?.address, 0x1003n, 'new-family target');
          equal(failure.pageFault?.errorCode, 0, 'legacy missing PTE fetch');
          const pte = new Uint8Array(4);
          put(pte, 0, 0x6003n, 4);
          cpu.writePhysicalMemory(0x4004n, pte);
          const resumed = await cpu.run({ budget: 1n });
          equal(resumed.reason, 'budget', 'repaired target');
          equal(resumed.state.rip, 0x1004n, 'target only');
          equal(resumed.retired, 1n, 'target retired once');
        } finally {
          cpu.dispose();
        }
      },
    },
    {
      name: 'committed PG deactivation produces a PG0 final-access refusal without replay or CR2 mutation',
      async run() {
        const ram = new Uint8Array(0x4000);
        put(ram, 0, 0x4003n, 4);
        put(ram, 0x1004, 0x5003n, 4);
        ram.set(hex('0f22c0'), 0x2000);
        const cpu = await createCpu({
          compiler,
          memoryModel: 'physical',
          context: protected32(),
          paging: { cr0: 0x80000033n, cr2: 0xdeadn, cr3: 0x3000n, cr4: 0x608n, efer: 0n },
          entry: 0x1000n,
          memory: {
            backings: [{ id: 'ram', bytes: ram }],
            mappings: [
              {
                base: 0x3000n,
                backing: 'ram',
                offset: 0,
                length: ram.length,
                permissions: { read: true, write: true, execute: true },
              },
            ],
          },
          memoryLimits: { maxBackings: 1, maxMappings: 1, maxBackingBytes: ram.length },
          limits: LIMITS,
        });
        try {
          const registers = Array<bigint>(16).fill(0n);
          registers[0] = 0x33n;
          cpu.setState({ registers, flags: 2n, rip: 0x1000n });
          const writer = await cpu.run({ budget: 1n });
          equal(writer.retired, 1n, 'disable writer completed');
          equal(writer.state.rip, 0x1003n, 'disable successor');
          equal(cpu.readPagingState().cr0, 0x33n, 'PG cleared');
          const fault = await cpu.run({ budget: 1n });
          equal(fault.reason, 'physical-memory-fault', 'PG0 backing refusal');
          equal(fault.physicalMemoryFault?.physicalAddress, 0x1003n, 'identity successor');
          equal(fault.physicalMemoryFault?.phase, 'final-access', 'no invented walk');
          equal(fault.retired, 0n, 'no replay');
          equal(cpu.readPagingState().cr2, 0xdeadn, 'private refusal keeps CR2');
        } finally {
          cpu.dispose();
        }
      },
    },
    {
      name: 'physical snapshots retain raw system roots nonlong FS GS and unusable SS across constructor restore',
      async run() {
        const ram = new Uint8Array(0x10000),
          rom = new Uint8Array(0x10000);
        ram.set(hex('9050'), 0x1000);
        const c = protected32();
        c.segments.cs.type = 'read-write';
        c.segments.cs.base = 0x100000000n;
        c.segments.ss.usable = false;
        c.segments.fs.base = 0x123456789abcdef0n;
        c.segments.gs.base = 0xfedcba9876543210n;
        c.gdtr.base = 0xffff123456789abcn;
        c.idtr.base = 0x123456789abcdef0n;
        c.ldtr.base = 0x8000000000000000n;
        c.tr.base = 0xabcdef0123456789n;
        const bank = {
            cr0: 0x33n,
            cr2: 0xffff800000001234n,
            cr3: 0x8000000003018n,
            cr4: 0x608n,
            efer: 0n,
          },
          cpu = await physicalCpu(compiler, ram, rom, bank, c);
        let restored: Awaited<ReturnType<typeof physicalCpu>> | undefined;
        try {
          const registers = Array<bigint>(16).fill(0n);
          registers[4] = 0x8000n;
          cpu.setState({ registers, flags: 2n, rip: 0x1000n });
          const snap = cpu.readContext();
          restored = await physicalCpu(compiler, ram, rom, cpu.readPagingState(), snap);
          restored.setState(cpu.readState());
          for (const active of [cpu, restored]) {
            equal(active.readContext().gdtr.base, c.gdtr.base, 'raw GDTR');
            equal(active.readContext().segments.fs.base, c.segments.fs.base, 'raw FS');
            const nop = await active.run({ budget: 1n });
            equal(nop.retired, 1n, 'retained RW CS fetch');
            const stack = await active.run({ budget: 1n });
            equal(stack.reason, 'segment-fault', 'retained unusable SS');
            equal(stack.retired, 0n, 'no partial push');
            equal(active.readPagingState().cr2, bank.cr2, 'raw CR2 preserved');
          }
        } finally {
          cpu.dispose();
          restored?.dispose();
        }
      },
    },
    {
      name: 'unbacked hardware reset vector does not alias the ordinary real FFFF0 vector',
      async run() {
        const cpu = await createCpu({
          compiler,
          memoryModel: 'physical',
          context: resetContext(),
          paging: { cr0: 0x60000010n, cr2: 0n, cr3: 0n, cr4: 0n, efer: 0n },
          entry: 0xfff0n,
          memory: {
            backings: [{ id: 'decoy', bytes: hex('90') }],
            mappings: [
              {
                base: 0xffff0n,
                backing: 'decoy',
                offset: 0,
                length: 1,
                permissions: { read: true, write: false, execute: true },
              },
            ],
          },
          memoryLimits: { maxBackings: 1, maxMappings: 1, maxBackingBytes: 1 },
          limits: LIMITS,
        });
        try {
          cpu.reset();
          const result = await cpu.run({ budget: 1n });
          equal(result.reason, 'physical-memory-fault', 'high vector missing');
          equal(result.retired, 0n, 'no reset retirement');
          equal(result.physicalMemoryFault?.address, 0xfffffff0n, 'formed vector');
          equal(result.physicalMemoryFault?.physicalAddress, 0xfffffff0n, 'physical vector');
          equal(
            result.physicalMemoryFault?.failingPhysicalAddress,
            0xfffffff0n,
            'first required byte',
          );
          equal(result.physicalMemoryFault?.phase, 'final-access', 'no table phase');
          equal(cpu.readPagingState().cr2, 0n, 'no synthetic PF');
        } finally {
          cpu.dispose();
        }
      },
    },
  ];
}
