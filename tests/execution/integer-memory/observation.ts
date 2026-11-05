import {
  createFixture,
  type Scenario,
  CODE,
  changed,
  equal,
  exit,
  fault,
  hex,
  memory,
} from '../fixture.js';
import { frame, input, logicalExit, noFault } from './fixture.js';

export function observationScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createFixture(core);
  return [
    {
      name: 'repairing a failed memory ADD never replays an earlier committed store',
      run: async () => {
        await using(
          '488903480116',
          async (cpu) => {
            const before = input(CODE, { 0: 2n, 3: 0x4000n, 2: 3n, 6: 0x7000n });
            cpu.setState(before);
            const failed = await cpu.run({ budget: 3n });
            exit(failed, 'data-fault', 3n, 1n, changed(before, 0x1003n));
            fault(failed, {
              instructionPc: 0x1003n,
              address: 0x7000n,
              width: 8,
              access: 'write',
              cause: 'unmapped',
              failingAddress: 0x7000n,
            });
            memory(cpu, 0x4000n, '02000000000000000000000000000000');

            cpu.writeMemory(0x4000n, hex('0a00000000000000'));
            const repaired = changed(failed.state, 0x1003n, { 6: 0x4000n });
            cpu.setState(repaired);
            const resumed = await cpu.run({ budget: 1n });
            exit(resumed, 'budget', 1n, 1n, changed(repaired, 0x1006n, {}, 2n));
            noFault(resumed);
            equal(resumed.resources.compilations, 0, 'repair reuses the admitted RMW entry');
            memory(cpu, 0x4000n, '0d000000000000000000000000000000');

            for (const gated of [
              { budget: 1n, stop: undefined, reason: 'budget', remaining: 0n },
              { budget: 3n, stop: 0x1003n, reason: 'stop', remaining: 2n },
            ]) {
              cpu.writeMemory(0x4000n, new Uint8Array(16));
              cpu.setState(before);
              const result = await cpu.run(
                gated.stop === undefined
                  ? { budget: gated.budget }
                  : { budget: gated.budget, stop: gated.stop },
              );
              exit(result, gated.reason, gated.budget, 1n, changed(before, 0x1003n));
              equal(result.remaining, gated.remaining, 'remaining at the unexecuted ADD');
              noFault(result);
              equal(result.resources.compilations, 0, 'budget and stop reuse the same artifact');
              memory(cpu, 0x4000n, '02000000000000000000000000000000');
            }
          },
          { ramBase: 0x4000n, ram: '00'.repeat(16) },
        );
      },
    },
    {
      name: 'cached register-destination reads use fresh RAM and incoming aliased index values',
      run: async () => {
        const original = frame('05000000000000000900000000000000');
        await using(
          'b90000000048030c8b',
          async (cpu) => {
            const before = input();
            cpu.setState(before);
            const compiled = await cpu.run({ budget: 2n });
            exit(compiled, 'budget', 2n, 2n, changed(before, 0x1009n, { 1: 5n }, 6n));
            noFault(compiled);
            equal(
              cpu.inspectTranslations()[0]!.entries.map(String).join(','),
              [0x1000n, 0x1005n].map(String).join(','),
              'both read-program entries admitted',
            );
            memory(cpu, 0x4000n, original);

            cpu.writeMemory(0x4010n, hex('0a00000000000000'));
            const ramOnly = input(0x1005n, { 1: 0n });
            cpu.setState(ramOnly);
            const changedRam = await cpu.run({ budget: 1n });
            exit(changedRam, 'budget', 1n, 1n, changed(ramOnly, 0x1009n, { 1: 10n }, 6n));
            noFault(changedRam);
            equal(changedRam.resources.compilations, 0, 'changed RAM retains the read artifact');
            memory(cpu, 0x4000n, frame('0a000000000000000900000000000000'));

            cpu.writeMemory(0x4018n, hex('0700000000000000'));
            const fresh = input(0x1005n, { 0: 0x5566778880000103n, 3: 0x4008n, 1: 4n }, 0x12n);
            cpu.setState(fresh);
            const reused = await cpu.run({ budget: 1n });
            exit(reused, 'budget', 1n, 1n, changed(fresh, 0x1009n, { 1: 11n }, 2n));
            noFault(reused);
            equal(reused.resources.compilations, 0, 'fresh base and index reuse the middle entry');
            memory(cpu, 0x4000n, frame('0a000000000000000700000000000000'));

            const invalid = input(0x1005n, { 3: 0x7000n, 1: 0n }, 0x12n);
            cpu.setState(invalid);
            const failed = await cpu.run({ budget: 1n });
            exit(failed, 'data-fault', 1n, 0n, invalid);
            fault(failed, {
              instructionPc: 0x1005n,
              address: 0x7000n,
              width: 8,
              access: 'read',
              cause: 'unmapped',
              failingAddress: 0x7000n,
            });
            equal(failed.resources.compilations, 0, 'faulting middle entry is still cached');
            memory(cpu, 0x4000n, frame('0a000000000000000700000000000000'));
          },
          { ramBase: 0x4000n, ram: original },
        );
      },
    },
    {
      name: 'cached memory destinations use fresh old values and aliased source-address registers',
      run: async () => {
        const original = frame('05000000000000000900000000000000');
        await using(
          'b90200000048010c8b',
          async (cpu) => {
            const before = input(CODE, { 3: 0x4008n });
            cpu.setState(before);
            const compiled = await cpu.run({ budget: 2n });
            exit(compiled, 'budget', 2n, 2n, changed(before, 0x1009n, { 1: 2n }, 2n));
            noFault(compiled);
            memory(cpu, 0x4000n, frame('07000000000000000900000000000000'));

            cpu.writeMemory(0x4010n, hex('0a00000000000000'));
            const ramOnly = input(0x1005n, { 3: 0x4008n, 1: 2n });
            cpu.setState(ramOnly);
            const changedRam = await cpu.run({ budget: 1n });
            exit(changedRam, 'budget', 1n, 1n, changed(ramOnly, 0x1009n, {}, 6n));
            noFault(changedRam);
            equal(changedRam.resources.compilations, 0, 'changed old operand reuses RMW code');
            memory(cpu, 0x4000n, frame('0c000000000000000900000000000000'));

            cpu.writeMemory(0x4018n, hex('0a00000000000000'));
            const fresh = input(0x1005n, { 3: 0x4008n, 1: 4n }, 0x12n);
            cpu.setState(fresh);
            const reused = await cpu.run({ budget: 1n });
            exit(reused, 'budget', 1n, 1n, changed(fresh, 0x1009n, {}, 2n));
            noFault(reused);
            equal(reused.resources.compilations, 0, 'source-index alias uses fresh incoming state');
            memory(cpu, 0x4000n, frame('0c000000000000000e00000000000000'));

            const invalid = input(0x1005n, { 3: 0x7000n, 1: 0n }, 0x12n);
            cpu.setState(invalid);
            const failed = await cpu.run({ budget: 1n });
            exit(failed, 'data-fault', 1n, 0n, invalid);
            fault(failed, {
              instructionPc: 0x1005n,
              address: 0x7000n,
              width: 8,
              access: 'write',
              cause: 'unmapped',
              failingAddress: 0x7000n,
            });
            equal(failed.resources.compilations, 0, 'faulting RMW middle entry is cached');
            memory(cpu, 0x4000n, frame('0c000000000000000e00000000000000'));
          },
          { ramBase: 0x4000n, ram: original },
        );
      },
    },
    {
      name: 'memory integer flags feed internal conditions before public state publication',
      run: async () => {
        for (const packet of [
          {
            code: '4839037507b901000000eb05b902000000',
            stop: 0x1011n,
            entries: [0x1000n, 0x1003n, 0x1005n, 0x100an, 0x100cn],
            word: '0200000000000000',
            incomingFlags: 2n,
            flags: 0x46n,
            rcx: 1n,
            retired: 4n,
            logical: false,
          },
          {
            code: '4839037507b901000000eb05b902000000',
            stop: 0x1011n,
            entries: [0x1000n, 0x1003n, 0x1005n, 0x100an, 0x100cn],
            word: '0100000000000000',
            incomingFlags: 0x42n,
            flags: 0x97n,
            rcx: 2n,
            retired: 3n,
            logical: false,
          },
          {
            code: '48830b007807b901000000eb05b902000000',
            stop: 0x1012n,
            entries: [0x1000n, 0x1004n, 0x1006n, 0x100bn, 0x100dn],
            word: '0100000000000000',
            incomingFlags: 0x82n,
            flags: 2n,
            rcx: 1n,
            retired: 4n,
            logical: true,
          },
          {
            code: '48830b007807b901000000eb05b902000000',
            stop: 0x1012n,
            entries: [0x1000n, 0x1004n, 0x1006n, 0x100bn, 0x100dn],
            word: '0100000000000080',
            incomingFlags: 0x12n,
            flags: 0x82n,
            rcx: 2n,
            retired: 3n,
            logical: true,
          },
        ]) {
          const ram = frame(packet.word);
          await using(
            packet.code,
            async (cpu) => {
              const before = input(CODE, { 0: 2n }, packet.incomingFlags);
              cpu.setState(before);
              const result = await cpu.run({ budget: 5n, stop: packet.stop });
              const assertExit = packet.logical ? logicalExit : exit;
              assertExit(
                result,
                'stop',
                5n,
                packet.retired,
                changed(before, packet.stop, { 1: packet.rcx }, packet.flags),
              );
              noFault(result);
              equal(
                result.resources.nativeEntries,
                1,
                'condition consumes flags in one invocation',
              );
              equal(result.resources.dispatches, 0, 'internal condition never returns to dispatch');
              const units = cpu.inspectTranslations();
              equal(units.length, 1, 'producer and both paths share one artifact');
              equal(
                units[0]!.entries.length,
                packet.entries.length,
                'all diamond entries admitted',
              );
              for (const entry of packet.entries)
                equal(
                  units[0]!.entries.includes(entry),
                  true,
                  `internal entry ${entry.toString(16)}`,
                );
              memory(cpu, 0x4000n, ram);
            },
            { ramBase: 0x4000n, ram },
          );
        }
      },
    },
    {
      name: 'published logical memory flags survive preserving instructions and failed memory compares',
      run: async () => {
        const original = frame('0100000000000080');
        await using(
          '488323ff488903483906',
          async (cpu) => {
            const before = input(CODE, { 0: 2n, 6: 0x7000n });
            cpu.setState(before);
            const produced = await cpu.run({ budget: 1n });
            logicalExit(produced, 'budget', 1n, 1n, changed(before, 0x1004n, {}, 0x82n));
            noFault(produced);
            memory(cpu, 0x4000n, original);
            const stored = await cpu.run({ budget: 1n });
            exit(stored, 'budget', 1n, 1n, changed(produced.state, 0x1007n));
            noFault(stored);
            memory(cpu, 0x4000n, frame('0200000000000000'));
            const failed = await cpu.run({ budget: 1n });
            exit(failed, 'data-fault', 1n, 0n, stored.state);
            fault(failed, {
              instructionPc: 0x1007n,
              address: 0x7000n,
              width: 8,
              access: 'read',
              cause: 'unmapped',
              failingAddress: 0x7000n,
            });
            memory(cpu, 0x4000n, frame('0200000000000000'));

            cpu.writeMemory(0x4010n, hex('0a00000000000000'));
            const repaired = changed(failed.state, 0x1007n, { 6: 0x4010n });
            cpu.setState(repaired);
            const compared = await cpu.run({ budget: 1n });
            exit(compared, 'budget', 1n, 1n, changed(repaired, 0x100an, {}, 2n));
            noFault(compared);
            equal(compared.resources.compilations, 0, 'defined compare reuses the faulted entry');
            memory(cpu, 0x4000n, frame('0a00000000000000'));
          },
          { ramBase: 0x4000n, ram: original },
        );
      },
    },
  ];
}
