import { createCpu } from '../../../host/index.js';
import {
  AC,
  DATA,
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

export function supervisorProfileScenarios(compiler: WebAssembly.Module): Scenario[] {
  const side = { createCpu, compiler };
  return [
    {
      name: 'supervisor large4MiB2MiB1GiB literal leaves retain SMAP AC and SMEP fetch distinctions',
      async run() {
        for (const [family, size] of [
          ['non-pae', 22],
          ['pae', 21],
          ['ia32e', 21],
          ['ia32e', 30],
          ['fixed', 21],
          ['fixed', 30],
        ] as const)
          for (const user of [false, true])
            for (const ac of [false, true])
              for (const fetch of [false, true]) {
                const f = fixture(side, family, '8b03');
                f.paging.cr3 = 0x10000n;
                f.paging.cr4 |= (fetch ? SMEP : SMAP) | (family === 'non-pae' ? 0x10n : 0n);
                const leaf = 0xe3n | (user ? 4n : 0n);
                if (family === 'non-pae') put(f.bytes, 0x10000, leaf, 4);
                else if (family === 'pae') {
                  f.paging.pdpte = [0x11001n, 0n, 0n, 0n];
                  put(f.bytes, 0x10000, 0x11001n);
                  put(f.bytes, 0x11000, leaf);
                } else {
                  put(f.bytes, 0x10000, 0x11027n);
                  put(f.bytes, 0x11000, size === 30 ? leaf : 0x12027n);
                  if (size === 21) put(f.bytes, 0x12000, leaf);
                }
                f.bytes.set(hex('8b03'), Number(PC));
                f.bytes.set(fetch ? hex('90') : hex('12345678'), Number(DATA));
                await using(side, f, async (cpu) => {
                  const before = state(2n | (ac ? AC : 0n), fetch ? DATA : PC);
                  cpu.setState(before);
                  const numeric = preserved(cpu);
                  const result = await cpu.run({ budget: 1n }),
                    allowed = !user || (!fetch && ac);
                  same(
                    result.reason,
                    allowed ? 'budget' : 'page-fault',
                    `${family} ${size} large leaf verdict`,
                  );
                  same(result.retired, allowed ? 1n : 0n, 'large leaf retirement');
                  const expected = structuredClone(before);
                  if (allowed) {
                    expected.rip += fetch ? 1n : 2n;
                    if (!fetch)
                      expected.registers[0] =
                        family === 'ia32e' || family === 'fixed'
                          ? 0x78563412n
                          : 0x1122334478563412n;
                  }
                  same(result.state, expected, 'large leaf full scalar');
                  same(
                    result.pageFault,
                    allowed
                      ? undefined
                      : {
                          vector: 14,
                          address: DATA,
                          access: fetch ? 'execute' : 'read',
                          errorCode: fetch ? 17 : 1,
                          instructionPc: fetch ? DATA : PC,
                        },
                    'large leaf full fault',
                  );
                  numeric();
                  memory(cpu, f.bytes, 'large leaf stable A D');
                });
              }
      },
    },
  ];
}
