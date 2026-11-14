import { memory as scalarMemory, exit, fault } from '../../support/fixture.js';
import {
  PC,
  RAM_BASE,
  RAM_SIZE,
  compoundProfiles,
  input,
  linear,
  memory,
  completed,
  same,
  equal,
  put,
  preserved,
  hex,
  bytes,
  type CompoundProfile,
  type Scenario,
} from './compound-fixture.js';

const protected32 = compoundProfiles.find((p) => p.name === 'protected/32/32')!;
const protectedWordStack = compoundProfiles.find((p) => p.name === 'protected/32/16')!;
const long64 = compoundProfiles.at(-1)!;

export function compoundLiteralScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'compound ENTER literal raw FrameTemp allocation borrow and Long64 word merge preserve full banks',
      async run() {
        const packets: {
          profile: CompoundProfile;
          code: string;
          sp: bigint;
          bp: bigint;
          nextSp: bigint;
          nextBp: bigint;
          base: bigint;
          length: number;
          at: number;
          saved: bigint;
          width: number;
        }[] = [
          {
            profile: protectedWordStack,
            code: 'c8000000',
            sp: 0x1122334400010010n,
            bp: 0x5566778800021234n,
            nextSp: 0x112233440001000cn,
            nextBp: 0x556677880001000cn,
            base: 0n,
            length: 32,
            at: 12,
            saved: 0x21234n,
            width: 4,
          },
          {
            profile: protected32,
            code: '66c8040000',
            sp: 0x1122334400010002n,
            bp: 0x5566778800021234n,
            nextSp: 0x112233440000fffcn,
            nextBp: 0x5566778800020000n,
            base: 0xfff0n,
            length: 32,
            at: 16,
            saved: 0x1234n,
            width: 2,
          },
          {
            profile: long64,
            code: '66c8080000',
            sp: 0x100000010n,
            bp: 0x100001235n,
            nextSp: 0x100000006n,
            nextBp: 0x10000000en,
            base: 0x100000000n,
            length: 32,
            at: 14,
            saved: 0x1235n,
            width: 2,
          },
          {
            profile: long64,
            code: '6766c8080000',
            sp: 0x100000010n,
            bp: 0x100001235n,
            nextSp: 0x100000006n,
            nextBp: 0x10000000en,
            base: 0x100000000n,
            length: 32,
            at: 14,
            saved: 0x1235n,
            width: 2,
          },
          {
            profile: long64,
            code: '6648c8000000',
            sp: 0x5000n,
            bp: 0x1122334455667788n,
            nextSp: 0x4ff8n,
            nextBp: 0x4ff8n,
            base: 0x4ff0n,
            length: 32,
            at: 8,
            saved: 0x1122334455667788n,
            width: 8,
          },
          {
            profile: long64,
            code: '4866c8000000',
            sp: 0x5000n,
            bp: 0x1122334455667788n,
            nextSp: 0x4ffen,
            nextBp: 0x1122334455664ffen,
            base: 0x4ff0n,
            length: 32,
            at: 14,
            saved: 0x7788n,
            width: 2,
          },
        ];
        for (const packet of packets) {
          const ram = new Uint8Array(packet.length).fill(0xa5),
            wanted = ram.slice();
          put(wanted, packet.at, packet.saved, packet.width);
          await linear(
            compiler,
            packet.code,
            packet.profile,
            async (cpu) => {
              const before = input(packet.profile, { 4: packet.sp, 5: packet.bp });
              cpu.setState(before);
              cpu.setTimeState({ tsc: 100n, tscAux: 0x89abcdef });
              const numeric = preserved(cpu),
                result = await cpu.run({ budget: 1n, repeatBudget: 0n });
              completed(cpu, result, before, PC + BigInt(packet.code.length / 2), {
                4: packet.nextSp,
                5: packet.nextBp,
              });
              memory(cpu, packet.base, wanted, 'literal mixed-width RAM');
              numeric();
            },
            {
              data: [{ base: packet.base, bytes: Array.from(ram, (v) => v.toString(16)).join('') }],
            },
          );
        }
      },
    },
    {
      name: 'compound PUSHA original ESP differs from the wrapping word stack cursor',
      async run() {
        const low = new Uint8Array(32).fill(0xa5),
          high = new Uint8Array(32).fill(0xa5);
        await linear(
          compiler,
          '60',
          protectedWordStack,
          async (cpu) => {
            const before = input(protectedWordStack, { 4: 0x1122334400010010n });
            cpu.setState(before);
            cpu.setTimeState({ tsc: 100n, tscAux: 0x89abcdef });
            const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
            completed(cpu, result, before, PC + 1n, { 4: 0x112233440001fff0n });
            const wantedLow = low.slice(),
              wantedHigh = high.slice();
            for (let bank = 0; bank < 4; bank++)
              put(wantedLow, 12 - 4 * bank, before.registers[bank]!, 4);
            for (let bank = 4; bank < 8; bank++)
              put(wantedHigh, 28 - 4 * (bank - 4), before.registers[bank]!, 4);
            memory(cpu, 0n, wantedLow, 'PUSHA low wrap');
            memory(cpu, 0xffe0n, wantedHigh, 'PUSHA high wrap');
            scalarMemory(cpu, 0xfffcn, '10000100');
          },
          {
            data: [
              { base: 0n, bytes: 'a5'.repeat(32) },
              { base: 0xffe0n, bytes: 'a5'.repeat(32) },
            ],
          },
        );
      },
    },
    {
      name: 'compound POPA skipped backing and skipped SS crossing produce no read or watchpoint',
      async run() {
        for (const wrapStack of [false, true]) {
          const profile = wrapStack ? protectedWordStack : protected32;
          const ctx = structuredClone(profile) as CompoundProfile;
          if ('segments' in ctx.execution)
            ctx.execution.segments.ss.limit = wrapStack ? 0xffff : 0xffffffff;
          const addresses = wrapStack
            ? [0xfff3n, 0xfff7n, 0xfffbn, 3n, 7n, 0xbn, 0xfn]
            : [0x4000n, 0x4004n, 0x4008n, 0x4010n, 0x4014n, 0x4018n, 0x401cn];
          const values = [
            0x10101010n,
            0x20202020n,
            0x30303030n,
            0x40404040n,
            0x50505050n,
            0x60606060n,
            0x70707070n,
          ];
          const data = addresses.map((base, index) => ({
            base,
            bytes: bytes(values[index]!, 4),
            write: false,
          }));
          await linear(
            compiler,
            '61',
            ctx,
            async (cpu) => {
              const oldSp = wrapStack ? 0x112233440000fff3n : 0x1122334400004000n;
              const before = input(ctx, { 3: 0x1122334400000003n, 4: oldSp });
              cpu.setState(before);
              cpu.setTimeState({ tsc: 100n, tscAux: 0x89abcdef });
              cpu.setDebugState({
                addresses: [wrapStack ? 0xffffn : 0x400cn, 0n, 0n, 0n],
                dr6: 0n,
                dr7: wrapStack ? 0x30401n : 0xf0401n,
              });
              const debug = cpu.readDebugState(),
                result = await cpu.run({ budget: 1n, repeatBudget: 0n });
              completed(cpu, result, before, PC + 1n, {
                7: 0x1122334410101010n,
                6: 0x1122334420202020n,
                5: 0x5566778830303030n,
                3: 0x1122334440404040n,
                2: 0x1122334450505050n,
                1: 0x1122334460606060n,
                0: 0x1122334470707070n,
                4: wrapStack ? 0x1122334400000013n : 0x1122334400004020n,
              });
              same(cpu.readDebugState(), debug, 'skipped bytes have no debug cause');
              equal(result.debugException, undefined, 'no skipped-slot trap');
              for (let index = 0; index < addresses.length; index++)
                scalarMemory(cpu, addresses[index]!, bytes(values[index]!, 4));
            },
            { data },
          );
        }
      },
    },
    {
      name: 'compound ENTER progressive aliases retain failed payload and a fresh retry observes its residue',
      async run() {
        for (const failProbe of [false, true]) {
          const ram = new Uint8Array(RAM_SIZE).fill(0xa5);
          put(ram, 0xff4, 0x11111111n, 4);
          put(ram, 0xff0, 0x22222222n, 4);
          const code = failProbe ? 'c8001003' : 'c8000003';
          await linear(
            compiler,
            code,
            protected32,
            async (cpu) => {
              const before = input(protected32, { 4: 0x5000n, 5: 0x4ff8n });
              cpu.setState(before);
              cpu.setTimeState({ tsc: 100n, tscAux: 0x89abcdef });
              const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
              const first = ram.slice();
              for (const [at, value] of [
                [0xffc, 0x4ff8n],
                [0xff8, 0x11111111n],
                [0xff4, 0x22222222n],
                [0xff0, 0x4ffcn],
              ] as const)
                put(first, at, value, 4);
              memory(cpu, RAM_BASE, first, 'progressive first-attempt payload');
              if (!failProbe) {
                completed(cpu, result, before, PC + 4n, { 4: 0x4ff0n, 5: 0x4ffcn });
                return;
              }
              exit(result, 'data-fault', 1n, 0n, before);
              fault(result, {
                instructionPc: PC,
                address: 0x3ff0n,
                width: 1,
                access: 'write',
                cause: 'unmapped',
                failingAddress: 0x3ff0n,
                segment: 'ss',
              });
              equal(cpu.readTimeState().tsc, 100n, 'failed probe no tick');
              cpu.addBacking({ id: 'endpoint', bytes: hex('a5') });
              cpu.setMappings([
                {
                  base: PC,
                  backing: 'code',
                  offset: 0,
                  length: 4,
                  permissions: { read: true, write: false, execute: true },
                },
                {
                  base: RAM_BASE,
                  backing: 'data0',
                  offset: 0,
                  length: RAM_SIZE,
                  permissions: { read: true, write: true, execute: false },
                },
                {
                  base: 0x3ff0n,
                  backing: 'endpoint',
                  offset: 0,
                  length: 1,
                  permissions: { read: false, write: true, execute: false },
                },
              ]);
              const retry = await cpu.run({ budget: 1n, repeatBudget: 0n });
              completed(cpu, retry, before, PC + 4n, { 4: 0x3ff0n, 5: 0x4ffcn });
              put(first, 0xff8, 0x22222222n, 4);
              put(first, 0xff4, 0x4ffcn, 4);
              memory(cpu, RAM_BASE, first, 'fresh retry observes retained aliases');
            },
            { ram },
          );
        }
      },
    },
    {
      name: 'compound ENTER body LEAVE RET and legacy save clobber restore execute complete guest procedures',
      async run() {
        const code = new Uint8Array(64).fill(0x90);
        code.set(hex('e80b000000'));
        code.set(hex('c8200000b811000000c9c3'), 16);
        await linear(
          compiler,
          Array.from(code, (v) => v.toString(16).padStart(2, '0')).join(''),
          long64,
          async (cpu) => {
            const before = input(long64);
            cpu.setState(before);
            cpu.setTimeState({ tsc: 100n, tscAux: 0x89abcdef });
            completed(
              cpu,
              await cpu.run({ budget: 5n, repeatBudget: 0n }),
              before,
              0x1005n,
              { 0: 0x11n },
              5n,
            );
            scalarMemory(cpu, 0x4ff0n, '00600000000000000510000000000000');
          },
        );
        for (const width of [2, 4]) {
          const prefix = width === 2 ? '66' : '';
          const program =
            prefix +
            '60' +
            [0, 1, 2, 3, 5, 6, 7]
              .map(
                (bank) => prefix + (0xb8 + bank).toString(16) + bytes(0x12n + BigInt(bank), width),
              )
              .join('') +
            prefix +
            '61';
          await linear(compiler, program, protected32, async (cpu) => {
            const before = input(protected32);
            cpu.setState(before);
            cpu.setTimeState({ tsc: 100n, tscAux: 0x89abcdef });
            completed(
              cpu,
              await cpu.run({ budget: 9n, repeatBudget: 0n }),
              before,
              PC + BigInt(program.length / 2),
              {},
              9n,
            );
          });
        }
      },
    },
  ];
}
