import {
  AC,
  AUX,
  DATA,
  PC,
  SMEP,
  SMAP,
  dwordMemory,
  families,
  fixture,
  memory,
  preserved,
  put,
  same,
  state,
  using,
  type Side,
} from './fixture.js';

export const groups = [
  'data-rights',
  'fetch-rights',
  'aggregate-rights',
  'flags',
  'metadata',
] as const;
export type Group = (typeof groups)[number];

// Manual table, deliberately independent of the production permission predicate and walker.
function dataAllowed(
  cpl: number,
  userPage: boolean,
  writable: boolean,
  wp: boolean,
  smap: boolean,
  ac: boolean,
): boolean {
  if (cpl === 3) return userPage && writable;
  if (userPage && smap && !ac) return false;
  return !wp || writable;
}

async function dataRights(side: Side): Promise<number> {
  let cases = 0;
  for (const family of families)
    for (const cpl of [0, 1, 2, 3])
      for (const user of [false, true])
        for (const ac of [false, true])
          for (const smap of [false, true])
            for (const wp of [false, true])
              for (const writable of [false, true])
                for (const write of [false, true]) {
                  const f = fixture(
                    side,
                    family,
                    dwordMemory(family === 'non-pae' || family === 'pae' ? 32 : 64, write),
                    { cpl },
                  );
                  f.paging.cr4 |= smap ? SMAP : 0n;
                  f.paging.cr0 |= wp ? 0x10000n : 0n;
                  f.leaf(Number(DATA), 0xa061n | (user ? 4n : 0n) | (writable ? 2n : 0n));
                  const allowed = write
                    ? dataAllowed(cpl, user, writable, wp, smap, ac)
                    : cpl === 3
                      ? user
                      : !user || !smap || ac;
                  await using(side, f, async (cpu) => {
                    cpu.setState(state(2n | (ac ? AC : 0n)));
                    cpu.setTimeState({ tsc: 100n, tscAux: AUX });
                    const before = cpu.readState(),
                      beforeContext = cpu.readContext(),
                      numeric = preserved(cpu);
                    const expectedRam = f.bytes.slice();
                    if (allowed && write) expectedRam.set([0xbe, 0xba, 0xfe, 0xca], 0xa000);
                    const result = await cpu.run({ budget: 1n });
                    const expected = structuredClone(before);
                    if (allowed) {
                      expected.rip = PC + 2n;
                      if (!write)
                        expected.registers[0] = f.bits === 64 ? 0x78563412n : 0x1122334478563412n;
                    }
                    same(
                      result.reason,
                      allowed ? 'budget' : 'page-fault',
                      'manual data-rights verdict',
                    );
                    same(result.retired, allowed ? 1n : 0n, 'manual data-rights retirement');
                    same(result.remaining, allowed ? 0n : 1n, 'manual data-rights allowance');
                    same(result.state, expected, 'manual data-rights full scalar state');
                    if (!allowed)
                      same(
                        result.pageFault,
                        {
                          vector: 14,
                          address: DATA,
                          access: write ? 'write' : 'read',
                          errorCode: 1 | (write ? 2 : 0) | (cpl === 3 ? 4 : 0),
                          instructionPc: PC,
                        },
                        'literal data PF packet',
                      );
                    same(
                      cpu.readPagingState(),
                      { ...f.paging, cr2: allowed ? 0xdeadn : DATA },
                      'data controls and requester PF',
                    );
                    same(cpu.readContext(), beforeContext, 'data context preservation');
                    same(
                      cpu.readTimeState(),
                      { tsc: allowed ? 101n : 100n, tscAux: AUX },
                      'data time ledger',
                    );
                    memory(cpu, expectedRam, 'data full RAM including table words');
                    numeric();
                  });
                  cases++;
                }
  return cases;
}

async function fetchRights(side: Side): Promise<number> {
  let cases = 0;
  for (const family of families)
    for (const cpl of [0, 1, 2, 3])
      for (const user of [false, true])
        for (const ac of [false, true])
          for (const smep of [false, true])
            for (const smap of [false, true])
              for (const nxe of [false, true])
                for (const xd of [false, true]) {
                  if (xd && (family === 'non-pae' || !nxe)) continue;
                  const f = fixture(side, family, '90', { cpl });
                  f.paging.cr4 |= (smep ? SMEP : 0n) | (smap ? SMAP : 0n);
                  f.paging.efer |= nxe ? 0x800n : 0n;
                  f.leaf(Number(DATA), 0xa063n | (user ? 4n : 0n) | (xd ? 1n << 63n : 0n));
                  f.bytes[0xa000] = 0x90;
                  const allowed = cpl === 3 ? user && !xd : (!user || !smep) && !xd;
                  await using(side, f, async (cpu) => {
                    cpu.setState(state(2n | (ac ? AC : 0n), DATA));
                    cpu.setTimeState({ tsc: 100n, tscAux: AUX });
                    const before = cpu.readState(),
                      beforeContext = cpu.readContext(),
                      numeric = preserved(cpu);
                    const result = await cpu.run({ budget: 1n });
                    same(
                      result.reason,
                      allowed ? 'budget' : 'page-fault',
                      'manual fetch-rights verdict',
                    );
                    same(result.retired, allowed ? 1n : 0n, 'fetch retirement');
                    same(
                      result.state,
                      { ...before, rip: allowed ? DATA + 1n : DATA },
                      'fetch full scalar state',
                    );
                    if (!allowed)
                      same(
                        result.pageFault,
                        {
                          vector: 14,
                          address: DATA,
                          access: 'execute',
                          errorCode:
                            1 |
                            (cpl === 3 ? 4 : 0) |
                            (smep || (family !== 'non-pae' && nxe) ? 16 : 0),
                          instructionPc: DATA,
                        },
                        'literal fetch PF packet',
                      );
                    same(
                      cpu.readPagingState(),
                      { ...f.paging, cr2: allowed ? 0xdeadn : DATA },
                      'fetch controls',
                    );
                    same(cpu.readContext(), beforeContext, 'fetch context');
                    same(
                      cpu.readTimeState(),
                      { tsc: allowed ? 101n : 100n, tscAux: AUX },
                      'fetch time ledger',
                    );
                    memory(cpu, f.bytes, 'fetch does not write already accessed tables');
                    numeric();
                  });
                  cases++;
                }
  return cases;
}

async function aggregateRights(side: Side): Promise<number> {
  let cases = 0;
  for (const family of families)
    for (const upperUser of [false, true])
      for (const leafUser of [false, true])
        for (const ac of [false, true])
          for (const write of [false, true]) {
            const f = fixture(
              side,
              family,
              dwordMemory(family === 'non-pae' || family === 'pae' ? 32 : 64, write),
            );
            f.paging.cr4 |= SMAP | SMEP;
            put(f.bytes, f.upper, BigInt(f.pt) | 0x23n | (upperUser ? 4n : 0n), f.width);
            f.leaf(Number(DATA), 0xa063n | (leafUser ? 4n : 0n));
            const allowed = !upperUser || !leafUser || ac;
            await using(side, f, async (cpu) => {
              cpu.setState(state(2n | (ac ? AC : 0n)));
              const result = await cpu.run({ budget: 1n });
              same(
                result.reason,
                allowed ? 'budget' : 'page-fault',
                'AND of controlling U/S words',
              );
              same(result.retired, allowed ? 1n : 0n, 'AND rights retirement');
              if (!allowed)
                same(result.pageFault?.errorCode, write ? 3 : 1, 'AND rights supervisor code');
            });
            cases++;
          }
  return cases;
}

async function flags(side: Side): Promise<number> {
  let cases = 0;
  for (const family of families)
    for (const bits of (family === 'ia32e' || family === 'fixed' ? [16, 32, 64] : [16, 32]) as (
      16 | 32 | 64
    )[]) {
      const load = dwordMemory(bits),
        code = '0f01cb' + load + '0f01ca' + load;
      for (const budgets of [[4], [1, 3], [2, 2], [3, 1], [1, 1, 1, 1], [0, 2, 0, 2]]) {
        const f = fixture(side, family, code, { bits });
        f.paging.cr4 |= SMAP;
        f.leaf(Number(DATA), 0xa067n);
        await using(side, f, async (cpu) => {
          cpu.setState(state());
          cpu.setTimeState({ tsc: 100n, tscAux: AUX });
          const before = cpu.readState(),
            savedContext = cpu.readContext(),
            numeric = preserved(cpu);
          let completed = 0n,
            compilations = 0,
            final;
          for (const budget of budgets) {
            final = await cpu.run({ budget: BigInt(budget) });
            completed += final.retired;
            compilations += final.resources.compilations;
          }
          same(final?.reason, 'page-fault', 'same-unit final CLAC denies');
          same(completed, 3n, 'partitioned three completed instructions');
          const expected = structuredClone(before);
          expected.rip = PC + BigInt(6 + load.length / 2);
          expected.registers[0] = bits === 64 ? 0x78563412n : 0x1122334478563412n;
          same(final?.state, expected, 'same-unit full state and no stale AC');
          same(
            final?.pageFault,
            {
              vector: 14,
              address: DATA,
              access: 'read',
              errorCode: 1,
              instructionPc: expected.rip,
            },
            'same-unit exact final read PF',
          );
          same(cpu.readPagingState(), { ...f.paging, cr2: DATA }, 'same-unit exact CR2');
          same(cpu.readContext(), savedContext, 'AC not a context key');
          same(cpu.readTimeState(), { tsc: 103n, tscAux: AUX }, 'partition-independent clock');
          same(cpu.inspectTranslations().length, 1, 'AC keeps one retained owner');
          same(compilations, 1, 'AC partitions never recompile');
          memory(cpu, f.bytes, 'same-unit complete RAM and preset A D');
          numeric();
        });
        cases++;
      }
      for (const set of [false, true]) {
        const f = fixture(side, family, set ? '0f01cb' : '0f01ca', { bits });
        await using(side, f, async (cpu) => {
          const before = state(0x8d7n | (set ? 0n : AC));
          cpu.setState(before);
          const result = await cpu.run({ budget: 1n });
          same(result.reason, 'budget', 'CPL0 flag instruction works with SMAP0');
          same(
            result.state,
            { ...before, rip: PC + 3n, flags: set ? before.flags! | AC : before.flags! & ~AC },
            'only AC flag semantics',
          );
          same(result.retired, 1n, 'flag instruction retirement');
        });
        cases++;
      }
    }
  return cases;
}

async function metadata(side: Side): Promise<number> {
  let cases = 0;
  for (const family of families)
    for (const cpl of [0, 3])
      for (const ac of [false, true])
        for (const userTable of [false, true])
          for (const smap of [false, true]) {
            const f = fixture(side, family, '8ed8', { cpl });
            f.paging.cr4 |= smap ? SMAP : 0n;
            f.leaf(0x7000, 0xb063n | (userTable ? 4n : 0n));
            put(f.bytes, 0xb008, 0x00cff3000000ffffn);
            const allowed = !userTable || !smap;
            await using(side, f, async (cpu) => {
              const before = state(2n | (ac ? AC : 0n));
              before.registers[0] = 0x112233440000000bn;
              cpu.setState(before);
              cpu.setTimeState({ tsc: 100n, tscAux: AUX });
              const saved = cpu.readState(),
                numeric = preserved(cpu);
              const result = await cpu.run({ budget: 1n });
              same(
                result.reason,
                allowed ? 'budget' : 'page-fault',
                'implicit supervisor ignores AC override',
              );
              same(result.retired, allowed ? 1n : 0n, 'metadata retirement');
              same(
                result.state,
                { ...saved, rip: allowed ? PC + 2n : PC },
                'metadata full scalar state',
              );
              if (!allowed)
                same(
                  result.pageFault,
                  {
                    vector: 14,
                    address: 0x7008n,
                    access: 'read',
                    errorCode: 1,
                    table: 'gdt',
                    systemPhase: 'descriptor-read',
                    selector: 0xb,
                    instructionPc: PC,
                  },
                  'CPL3 metadata is supervisor PFEC1',
                );
              else same(cpu.readContext().segments.ds.selector, 0xb, 'positive descriptor control');
              same(
                cpu.readTimeState(),
                { tsc: allowed ? 101n : 100n, tscAux: AUX },
                'metadata time',
              );
              memory(cpu, f.bytes, 'accessed metadata image unchanged');
              numeric();
            });
            cases++;
          }
  return cases;
}

const checks: Record<Group, (side: Side) => Promise<number>> = {
  'data-rights': dataRights,
  'fetch-rights': fetchRights,
  'aggregate-rights': aggregateRights,
  flags,
  metadata,
};
export async function checkSupervisorAccess(
  side: Side,
  selected: readonly Group[] = groups,
): Promise<{ groups: { name: Group; cases: number }[]; cases: number }> {
  const records = [];
  for (const name of selected) records.push({ name, cases: await checks[name](side) });
  return { groups: records, cases: records.reduce((sum, r) => sum + r.cases, 0) };
}
