import { createCpu } from '../../../host/index.js';
import { LIMITS, check, equal, fault, hex, memory } from '../../support/fixture.js';
import { LONG, changed, input, using, type Scenario } from '../modes/fixture.js';
import { outcome } from '../strings/fixture.js';

export function literalPackets(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'exchange literal NOP and opcode register aliases preserve or write their exact views',
      async run() {
        for (const [code, updates] of [
          ['90', {}],
          ['4490', {}],
          ['4890', {}],
          ['416690', {}],
          ['87c0', { 0: 0x55667788n }],
          ['4190', { 0: 0x01020304n, 8: 0x55667788n }],
          ['664190', { 0: 0x1122334455660304n, 8: 0xdeadbeef01027788n }],
        ] as const)
          await using(compiler, code, LONG, async (cpu) => {
            const before = input(
              0x1000n,
              { 0: 0x1122334455667788n, 8: 0xdeadbeef01020304n },
              0xcd7n,
            );
            cpu.setState(before);
            outcome(
              await cpu.run({ budget: 1n, repeatBudget: 0n }),
              'budget',
              1n,
              1n,
              0n,
              0n,
              changed(before, 0x1000n + BigInt(code.length / 2), updates),
            );
          });
      },
    },
    {
      name: 'exchange literal byte aliases snapshot both incoming views and XADD destination sum wins',
      async run() {
        for (const row of [
          { code: '86e0', raw: 0x112233445566127fn, result: 0x1122334455667f12n, flags: 0xcd7n },
          { code: '0fc0e0', raw: 0x112233445566127fn, result: 0x1122334455667f91n, flags: 0xc92n },
          { code: '0fc0c0', raw: 0x1122334455661280n, result: 0x1122334455661200n, flags: 0xc47n },
        ])
          await using(compiler, row.code, LONG, async (cpu) => {
            const before = input(0x1000n, { 0: row.raw }, 0xcd7n);
            cpu.setState(before);
            outcome(
              await cpu.run({ budget: 1n, repeatBudget: 0n }),
              'budget',
              1n,
              1n,
              0n,
              0n,
              changed(before, 0x1000n + BigInt(row.code.length / 2), { 0: row.result }, row.flags),
            );
          });
      },
    },
    {
      name: 'exchange literal memory source register updates cannot redirect their own stores',
      async run() {
        await using(
          compiler,
          '488736',
          LONG,
          async (cpu) => {
            const before = input(0x1000n, { 6: 0x6000n }, 0xcd7n);
            cpu.setState(before);
            outcome(
              await cpu.run({ budget: 1n, repeatBudget: 0n }),
              'budget',
              1n,
              1n,
              0n,
              0n,
              changed(before, 0x1003n, { 6: 0x7000n }),
            );
            memory(cpu, 0x6000n, '0060000000000000');
          },
          { data: [{ base: 0x6000n, bytes: '0070000000000000' }] },
        );
        await using(
          compiler,
          '0fc100',
          LONG,
          async (cpu) => {
            const before = input(0x1000n, { 0: 0x6000n }, 0xcd7n);
            cpu.setState(before);
            outcome(
              await cpu.run({ budget: 1n, repeatBudget: 0n }),
              'budget',
              1n,
              1n,
              0n,
              0n,
              changed(before, 0x1003n, { 0: 7n }, 0x402n),
            );
            memory(cpu, 0x6000n, '07600000');
          },
          { data: [{ base: 0x6000n, bytes: '07000000' }] },
        );
      },
    },
    {
      name: 'exchange literal CMPXCHG32 skips register writes on the unselected branch',
      async run() {
        for (const hit of [false, true])
          await using(compiler, '0fb1d9', LONG, async (cpu) => {
            const before = input(
              0x1000n,
              {
                0: 0x1122334400000001n,
                1: hit ? 0x99aabbcc00000001n : 0x99aabbcc00000002n,
                3: 0xdeadbeef00000003n,
              },
              0xcd7n,
            );
            cpu.setState(before);
            outcome(
              await cpu.run({ budget: 1n, repeatBudget: 0n }),
              'budget',
              1n,
              1n,
              0n,
              0n,
              changed(before, 0x1003n, hit ? { 1: 3n } : { 0: 2n }, hit ? 0x446n : 0x497n),
            );
          });
      },
    },
    {
      name: 'exchange literal CAS miss requires a complete writable destination and preserves hit accumulator',
      async run() {
        for (const hit of [false, true])
          for (const write of [false, true])
            await using(
              compiler,
              'f00fb11e',
              LONG,
              async (cpu) => {
                const before = input(
                  0x1000n,
                  { 0: 0x1122334400000001n, 3: 3n, 6: 0x6000n },
                  0xcd7n,
                );
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
                outcome(
                  result,
                  write ? 'budget' : 'data-fault',
                  1n,
                  write ? 1n : 0n,
                  0n,
                  0n,
                  write
                    ? changed(before, 0x1004n, hit ? {} : { 0: 2n }, hit ? 0x446n : 0x497n)
                    : before,
                );
                memory(cpu, 0x6000n, write && hit ? '03000000' : hit ? '01000000' : '02000000');
                if (!write)
                  fault(result, {
                    instructionPc: 0x1000n,
                    address: 0x6000n,
                    width: 4,
                    access: 'write',
                    cause: 'permission',
                    failingAddress: 0x6000n,
                    segment: 'ds',
                  });
              },
              { data: [{ base: 0x6000n, bytes: hit ? '01000000' : '02000000', write }] },
            );
      },
    },
    {
      name: 'exchange literal CMPXCHG8B pairs and immune operand prefix retain full success banks',
      async run() {
        for (const prefix of ['', '66', '44', '4866', 'f0'])
          for (const hit of [false, true])
            await using(
              compiler,
              prefix + '0fc70e',
              LONG,
              async (cpu) => {
                const before = input(
                  0x1000n,
                  {
                    0: hit ? 0xaaaabbbb11223344n : 0xaaaabbbb00000000n,
                    2: hit ? 0xccccdddd55667788n : 0xccccdddd00000000n,
                    3: 0xeeeeffff89abcdefn,
                    1: 0x1111222201234567n,
                    6: 0x6000n,
                  },
                  0xcd7n,
                );
                cpu.setState(before);
                outcome(
                  await cpu.run({ budget: 1n, repeatBudget: 0n }),
                  'budget',
                  1n,
                  1n,
                  0n,
                  0n,
                  changed(
                    before,
                    0x1003n + BigInt(prefix.length / 2),
                    hit ? {} : { 0: 0x11223344n, 2: 0x55667788n },
                    hit ? 0xcd7n : 0xc97n,
                  ),
                );
                memory(cpu, 0x6000n, hit ? 'efcdab8967452301' : '4433221188776655');
              },
              { data: [{ base: 0x6000n, bytes: '4433221188776655' }] },
            );
      },
    },
    {
      name: 'exchange literal identity locked ADD still checks W and computes ordinary ADD flags',
      async run() {
        for (const write of [false, true])
          await using(
            compiler,
            'f0830600',
            LONG,
            async (cpu) => {
              const before = input(0x1000n, { 6: 0x6000n }, 0xcd7n);
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
              outcome(
                result,
                write ? 'budget' : 'data-fault',
                1n,
                write ? 1n : 0n,
                0n,
                0n,
                write ? changed(before, 0x1004n, {}, 0x406n) : before,
              );
              memory(cpu, 0x6000n, 'ffffff7f');
              if (!write)
                fault(result, {
                  instructionPc: 0x1000n,
                  address: 0x6000n,
                  width: 4,
                  access: 'write',
                  cause: 'permission',
                  failingAddress: 0x6000n,
                  segment: 'ds',
                });
            },
            { data: [{ base: 0x6000n, bytes: 'ffffff7f', write }] },
          );
      },
    },
    {
      name: 'exchange literal failed CAS identity store invalidates a retained executable alias owner',
      async run() {
        const code = 'f00fb11eb902000000f4';
        const cpu = await createCpu({
          compiler,
          context: LONG,
          entry: 0x1000n,
          limits: LIMITS,
          memory: {
            backings: [
              { id: 'code', bytes: hex(code) },
              { id: 'data', bytes: hex('02000000') },
            ],
            mappings: [
              {
                base: 0x1000n,
                backing: 'code',
                offset: 0,
                length: 10,
                permissions: { read: true, write: false, execute: true },
              },
              {
                base: 0x3000n,
                backing: 'code',
                offset: 5,
                length: 4,
                permissions: { read: true, write: true, execute: false },
              },
              {
                base: 0x6000n,
                backing: 'data',
                offset: 0,
                length: 4,
                permissions: { read: true, write: true, execute: false },
              },
            ],
          },
          memoryLimits: { maxBackings: 2, maxMappings: 3, maxBackingBytes: 14 },
        });
        try {
          const warm = input(0x1000n, { 0: 1n, 3: 3n, 6: 0x6000n }, 0xcd7n);
          cpu.setState(warm);
          outcome(
            await cpu.run({ budget: 1n, repeatBudget: 0n }),
            'budget',
            1n,
            1n,
            0n,
            0n,
            changed(warm, 0x1004n, { 0: 2n }, 0x497n),
          );
          const owner = cpu.inspectTranslations()[0]!;
          check(owner.entries.includes(0x1004n), 'initial owner includes MOV entry');
          check(
            owner.dependencies.some(
              (span) => span.start <= 0x1005n && span.start + BigInt(span.length) >= 0x1009n,
            ),
            'initial owner includes immediate bytes',
          );
          const before = input(0x1000n, { 0: 1n, 3: 3n, 6: 0x3000n }, 0xcd7n);
          cpu.setState(before);
          const result = await cpu.run({ budget: 2n, repeatBudget: 0n });
          outcome(
            result,
            'budget',
            2n,
            2n,
            0n,
            0n,
            changed(before, 0x1009n, { 0: 2n, 1: 2n }, 0x497n),
          );
          equal(result.resources.compilations, 1, 'invalidated successor is translated again');
          equal(result.resources.nativeEntries, 2, 'CAS completes before replacement invocation');
          equal(result.resources.dispatches, 1, 'code identity store dispatches after retirement');
          check(
            cpu.inspectTranslations().every((entry) => entry.owner !== owner.owner),
            'old owner retired after identity write',
          );
          memory(cpu, 0x1000n, code);
        } finally {
          cpu.dispose();
        }
      },
    },
    {
      name: 'exchange literal selected diagnostic boundaries consume required suffixes before invalid LOCK',
      async run() {
        for (const code of [
          'f00fc1c0',
          'f090',
          '0fc7c8',
          '480fc7c8',
          'f0480fc7c8',
          'f00fba2c24',
          '0fc734',
          '66480fc70c',
        ])
          await using(compiler, code, LONG, async (cpu) => {
            const before = input(0x1000n, {}, 0xcd7n);
            cpu.setState(before);
            const reason =
              code === 'f00fba2c24'
                ? 'fetch-fault'
                : code === '0fc734' || code === '66480fc70c'
                  ? 'unsupported'
                  : 'invalid-encoding';
            const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
            outcome(result, reason, 1n, 0n, 0n, 0n, before);
            equal(result.resources.compilations, 0, 'diagnostic precedes translation');
            if (reason === 'fetch-fault')
              fault(result, {
                instructionPc: 0x1000n,
                address: 0x1005n,
                width: 1,
                access: 'execute',
                cause: 'unmapped',
                failingAddress: 0x1005n,
                segment: 'cs',
              });
          });
      },
    },
  ];
}
