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
import { input, logicalExit, noFault } from './fixture.js';

export function flagScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createFixture(core);
  const ram = '1011121314151617a0a1a2a3a4a5a6a7f0f1f2f3f4f5f6f7';
  return [
    {
      name: 'observed logical flags survive MOV LEA faults and resume before defined arithmetic',
      run: async () => {
        for (const producer of [
          { code: '31c0', rax: 0n },
          { code: '09c0', rax: 0n },
          { code: '21c0', rax: 0n },
          { code: '85c0', rax: 0x1122334400000000n },
        ])
          await using(
            `${producer.code}4889c2488d7301488b3e4883c001`,
            async (cpu) => {
              const before = input(CODE, { 0: 0x1122334400000000n, 3: 0x6fffn });
              cpu.setState(before);
              const produced = await cpu.run({ budget: 1n });
              logicalExit(
                produced,
                'budget',
                1n,
                1n,
                changed(before, 0x1002n, { 0: producer.rax }, 0x46n),
              );
              noFault(produced);
              memory(cpu, 0x3ff8n, ram);

              const preserved = changed(produced.state, 0x1009n, { 2: producer.rax, 6: 0x7000n });
              const suffix = await cpu.run({ budget: 2n });
              exit(suffix, 'budget', 2n, 2n, preserved);
              noFault(suffix);
              equal(suffix.resources.compilations, 0, 'MOV and LEA reuse the producer artifact');
              memory(cpu, 0x3ff8n, ram);
              const failed = await cpu.run({ budget: 1n });
              exit(failed, 'data-fault', 1n, 0n, preserved);
              fault(failed, {
                instructionPc: 0x1009n,
                address: 0x7000n,
                width: 8,
                access: 'read',
                cause: 'unmapped',
                failingAddress: 0x7000n,
              });
              memory(cpu, 0x3ff8n, ram);

              cpu.writeMemory(0x4000n, hex('0807060504030201'));
              const repaired = changed(failed.state, 0x1009n, { 6: 0x4000n });
              cpu.setState(repaired);
              const loaded = await cpu.run({ budget: 1n });
              exit(
                loaded,
                'budget',
                1n,
                1n,
                changed(repaired, 0x100cn, { 7: 0x0102030405060708n }),
              );
              noFault(loaded);
              equal(loaded.resources.compilations, 0, 'repaired suffix reuses its installed entry');
              const arithmetic = await cpu.run({ budget: 1n });
              exit(
                arithmetic,
                'budget',
                1n,
                1n,
                changed(loaded.state, 0x1010n, { 0: producer.rax + 1n }, 2n),
              );
              noFault(arithmetic);
              memory(cpu, 0x3ff8n, '10111213141516170807060504030201f0f1f2f3f4f5f6f7');

              const fresh = input(0x1002n, { 0: 0x5566778880000103n, 3: 0x6fffn }, 0x12n);
              cpu.setState(fresh);
              const middle = await cpu.run({ budget: 2n });
              exit(
                middle,
                'budget',
                2n,
                2n,
                changed(fresh, 0x1009n, { 2: 0x5566778880000103n, 6: 0x7000n }),
              );
              noFault(middle);
              equal(middle.resources.compilations, 0, 'fresh AF=1 middle entry reuses its owner');
              const middleFault = await cpu.run({ budget: 1n });
              exit(middleFault, 'data-fault', 1n, 0n, middle.state);
              fault(middleFault, {
                instructionPc: 0x1009n,
                address: 0x7000n,
                width: 8,
                access: 'read',
                cause: 'unmapped',
                failingAddress: 0x7000n,
              });
              memory(cpu, 0x3ff8n, '10111213141516170807060504030201f0f1f2f3f4f5f6f7');
            },
            { ramBase: 0x3ff8n, ram },
          );
      },
    },
  ];
}
