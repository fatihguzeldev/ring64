import {
  type Scenario,
  CODE,
  changed,
  equal,
  exit,
  fault,
  hex,
  memory,
} from '../../support/fixture.js';
import { PROGRAM, RAM, createStackFixture, input, noFault, stack, word } from './fixture.js';

export function observationScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createStackFixture(core);
  return [
    {
      name: 'static CALL discovers its callee and continuation while the callee edge stays internal',
      run: async () => {
        await using(PROGRAM, async (cpu) => {
          const before = input();
          cpu.setState(before);
          const prefix = await cpu.run({ budget: 2n });
          exit(prefix, 'budget', 2n, 2n, changed(before, 0x1015n, { 2: 2n, 4: 0x4018n }));
          noFault(prefix);
          equal(prefix.resources.nativeEntries, 1, 'static CALL callee is an internal edge');
          equal(prefix.resources.dispatches, 0, 'static CALL does not return to the dispatcher');
          const metadata = cpu.inspectTranslations()[0]!;
          equal(
            metadata.entries.map(String).join(','),
            [0x1000n, 0x1005n, 0x100an, 0x1010n, 0x1015n].map(String).join(','),
            'CALL target and continuation entry set',
          );
          equal(metadata.instructionCount, 5, 'CALL discovery instruction count');
          equal(metadata.sourceBytes, 18, 'CALL discovery distinct source bytes');
          memory(cpu, 0x4000n, stack(0x1005n, 24));
          for (const budget of [6n, 5n]) {
            cpu.writeMemory(0x4000n, hex(RAM));
            cpu.setState(before);
            const result = await cpu.run({ budget, stop: 0x1020n });
            exit(
              result,
              budget === 6n ? 'stop' : 'budget',
              budget,
              5n,
              changed(before, 0x1020n, { 1: 1n, 2: 2n }),
            );
            noFault(result);
            equal(result.resources.compilations, 0, 'retained CALL program is reused');
            memory(cpu, 0x4000n, stack(0x1005n, 24));
          }
          memory(cpu, CODE, PROGRAM);
        });
        const code = 'ffd0b901000000c3b802000000c3';
        await using(code, async (cpu) => {
          const before = input(CODE, { 0: 0x1008n });
          cpu.setState(before);
          const result = await cpu.run({ budget: 1n });
          exit(result, 'budget', 1n, 1n, changed(before, 0x1008n, { 4: 0x4018n }));
          noFault(result);
          const metadata = cpu.inspectTranslations()[0]!;
          equal(
            metadata.entries.map(String).join(','),
            [0x1000n, 0x1002n, 0x1007n].map(String).join(','),
            'register CALL discovers only its static continuation',
          );
          equal(
            metadata.sourceBytes,
            8,
            'register CALL does not inspect imported target registers',
          );
          memory(cpu, 0x4000n, stack(0x1002n, 24));
          memory(cpu, CODE, code);
        });
      },
    },
    {
      name: 'idle-patched and unmatched returns consume actual stack words rather than remembered continuations',
      run: async () => {
        await using(PROGRAM, async (cpu) => {
          const before = input();
          cpu.setState(before);
          const called = await cpu.run({ budget: 1n });
          exit(called, 'budget', 1n, 1n, changed(before, 0x1010n, { 4: 0x4018n }));
          noFault(called);
          memory(cpu, 0x4000n, stack(0x1005n, 24));
          cpu.writeMemory(0x4018n, hex(word(0x100an)));
          const resumed = await cpu.run({ budget: 4n, stop: 0x1020n });
          exit(resumed, 'stop', 4n, 3n, changed(before, 0x1020n, { 2: 2n }));
          noFault(resumed);
          memory(cpu, 0x4000n, stack(0x100an, 24));
          const unmatched = input(0x1015n, { 4: 0x4018n }, 0x12n);
          cpu.setState(unmatched);
          const returned = await cpu.run({ budget: 2n });
          exit(returned, 'budget', 2n, 2n, changed(unmatched, 0x1020n, { 4: 0x4020n }));
          noFault(returned);
          equal(
            returned.resources.compilations,
            0,
            'unmatched RET enters the cached middle without CALL facts',
          );
          memory(cpu, 0x4000n, stack(0x100an, 24));
          memory(cpu, CODE, PROGRAM);
        });
      },
    },
    {
      name: 'guest stores can replace a saved return word before RET executes',
      run: async () => {
        const code = 'e80b000000b901000000eb340000000048b80a1000000000000048890424c3';
        await using(code, async (cpu) => {
          const before = input();
          cpu.setState(before);
          const result = await cpu.run({ budget: 6n, stop: 0x1040n });
          exit(result, 'stop', 6n, 5n, changed(before, 0x1040n, { 0: 0x100an }));
          noFault(result);
          memory(cpu, 0x4000n, stack(0x100an, 24));
          memory(cpu, CODE, code);
        });
      },
    },
    {
      name: 'stops after CALL RET PUSH and POP publish each completed stack effect exactly once',
      run: async () => {
        await using(PROGRAM, async (cpu) => {
          const before = input();
          cpu.setState(before);
          const callStop = await cpu.run({ budget: 6n, stop: 0x1010n });
          const called = changed(before, 0x1010n, { 4: 0x4018n });
          exit(callStop, 'stop', 6n, 1n, called);
          noFault(callStop);
          memory(cpu, 0x4000n, stack(0x1005n, 24));
          const retStop = await cpu.run({ budget: 6n, stop: 0x1005n });
          const returned = changed(before, 0x1005n, { 2: 2n });
          exit(retStop, 'stop', 6n, 2n, returned);
          noFault(retStop);
          memory(cpu, 0x4000n, stack(0x1005n, 24));
          const resumed = await cpu.run({ budget: 3n, stop: 0x1020n });
          exit(resumed, 'stop', 3n, 2n, changed(returned, 0x1020n, { 1: 1n }));
          noFault(resumed);
          memory(cpu, 0x4000n, stack(0x1005n, 24));
          memory(cpu, CODE, PROGRAM);
        });
        await using('5458', async (cpu) => {
          const before = input();
          cpu.setState(before);
          const pushed = await cpu.run({ budget: 3n, stop: 0x1001n });
          exit(pushed, 'stop', 3n, 1n, changed(before, 0x1001n, { 4: 0x4018n }));
          noFault(pushed);
          memory(cpu, 0x4000n, stack(0x4020n, 24));
          const popped = await cpu.run({ budget: 2n, stop: 0x1002n });
          exit(popped, 'stop', 2n, 1n, changed(before, 0x1002n, { 0: 0x4020n }));
          noFault(popped);
          memory(cpu, 0x4000n, stack(0x4020n, 24));
          memory(cpu, CODE, '5458');
        });
      },
    },
    {
      name: 'repairing failed CALL and RET operands never replays an earlier committed store',
      run: async () => {
        for (const operation of ['call', 'ret-read', 'ret-target']) {
          const code = '48891b' + (operation === 'call' ? 'ffd0' : 'c3');
          const original = operation === 'ret-target' ? stack(0x800000000000n) : RAM;
          await using(
            code,
            async (cpu) => {
              const before = input(CODE, {
                0: 0x1010n,
                3: 0x4000n,
                4: operation === 'ret-target' ? 0x4020n : 0x7000n,
              });
              cpu.setState(before);
              const failed = await cpu.run({ budget: 3n });
              const failedState = changed(before, 0x1003n);
              exit(
                failed,
                operation === 'ret-target' ? 'target-fault' : 'data-fault',
                3n,
                1n,
                failedState,
              );
              fault(failed, {
                instructionPc: 0x1003n,
                address:
                  operation === 'call'
                    ? 0x6ff8n
                    : operation === 'ret-target'
                      ? 0x800000000000n
                      : 0x7000n,
                width: operation === 'ret-target' ? 0 : 8,
                access:
                  operation === 'call' ? 'write' : operation === 'ret-target' ? 'execute' : 'read',
                cause: operation === 'ret-target' ? 'noncanonical' : 'unmapped',
                failingAddress:
                  operation === 'call'
                    ? 0x6ff8n
                    : operation === 'ret-target'
                      ? 0x800000000000n
                      : 0x7000n,
              });
              memory(cpu, 0x4000n, word(0x4000n) + original.slice(16));
              cpu.writeMemory(0x4000n, hex(word(0x99n)));
              if (operation !== 'call') cpu.writeMemory(0x4020n, hex(word(0x1010n)));
              const repaired = changed(failedState, 0x1003n, { 4: 0x4020n });
              cpu.setState(repaired);
              const resumed = await cpu.run({ budget: 1n });
              exit(
                resumed,
                'budget',
                1n,
                1n,
                changed(repaired, 0x1010n, { 4: operation === 'call' ? 0x4018n : 0x4028n }),
              );
              noFault(resumed);
              equal(
                resumed.resources.compilations,
                0,
                'repair uses the same retained transfer entry',
              );
              memory(
                cpu,
                0x4000n,
                word(0x99n) +
                  'a5'.repeat(16) +
                  (operation === 'call' ? word(0x1005n) : 'a5'.repeat(8)) +
                  (operation === 'call' ? original.slice(64) : word(0x1010n) + 'a5'.repeat(24)),
              );
              memory(cpu, CODE, code);
            },
            { ram: original },
          );
        }
      },
    },
    {
      name: 'retained runtime targets report fresh full addresses and never leak fault metadata into another exit',
      run: async () => {
        for (const code of ['c3', 'ffd0', 'ffe0']) {
          await using(code, async (cpu) => {
            for (const target of [0x800000000000n, 0xffff7fff12345678n]) {
              const original = code === 'c3' ? stack(target) : RAM;
              cpu.writeMemory(0x4000n, hex(original));
              const before = input(CODE, { 0: target });
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              exit(result, 'target-fault', 1n, 0n, before);
              fault(result, {
                instructionPc: CODE,
                address: target,
                width: 0,
                access: 'execute',
                cause: 'noncanonical',
                failingAddress: target,
              });
              if (target !== 0x800000000000n)
                equal(
                  result.resources.compilations,
                  0,
                  'changed failure target retains the generated artifact',
                );
              memory(cpu, 0x4000n, original);
            }
            const valid = input(CODE, { 0: 0x1010n });
            cpu.writeMemory(0x4000n, hex(code === 'c3' ? stack(0x1010n) : RAM));
            cpu.setState(valid);
            const success = await cpu.run({ budget: 1n });
            exit(
              success,
              'budget',
              1n,
              1n,
              changed(valid, 0x1010n, {
                4: code === 'c3' ? 0x4028n : code === 'ffd0' ? 0x4018n : 0x4020n,
              }),
            );
            noFault(success);
            equal(
              success.resources.compilations,
              0,
              'success after target failure uses the same artifact',
            );
            const successRam =
              code === 'c3' ? stack(0x1010n) : code === 'ffd0' ? stack(0x1002n, 24) : RAM;
            memory(cpu, 0x4000n, successRam);
            const bad = input(CODE, { 0: 0x1010n, 4: 0x7000n });
            cpu.setState(bad);
            const next = await cpu.run({ budget: 1n });
            if (code === 'ffe0') {
              exit(next, 'budget', 1n, 1n, changed(bad, 0x1010n));
              noFault(next);
            } else {
              exit(next, 'data-fault', 1n, 0n, bad);
              const address = code === 'c3' ? 0x7000n : 0x6ff8n;
              fault(next, {
                instructionPc: CODE,
                address,
                width: 8,
                access: code === 'c3' ? 'read' : 'write',
                cause: 'unmapped',
                failingAddress: address,
              });
              const zero = await cpu.run({ budget: 0n, stop: CODE });
              exit(zero, 'budget', 0n, 0n, bad);
              noFault(zero);
              await cpu.run({ budget: 1n });
              const stopped = await cpu.run({ budget: 1n, stop: CODE });
              exit(stopped, 'stop', 1n, 0n, bad);
              noFault(stopped);
            }
            memory(cpu, 0x4000n, successRam);
            memory(cpu, CODE, code);
          });
        }
      },
    },
    {
      name: 'canonical transfer targets commit before budget stop unsupported or subsequent fetch failure',
      run: async () => {
        for (const operation of ['call', 'ret', 'jump'])
          for (const destination of ['unmapped', 'nx', 'unsupported', 'truncated']) {
            const instruction = operation === 'ret' ? 'c3' : operation === 'call' ? 'ffd0' : 'ffe0';
            const code =
              instruction +
              (destination === 'unsupported' ? '90' : destination === 'truncated' ? 'e8' : '');
            const target =
              destination === 'unmapped'
                ? 0x7000n
                : destination === 'nx'
                  ? 0x4010n
                  : CODE + BigInt(instruction.length / 2);
            const original = operation === 'ret' ? stack(target) : RAM;
            await using(
              code,
              async (cpu) => {
                const before = input(CODE, { 0: target });
                const after = changed(before, target, {
                  4: operation === 'ret' ? 0x4028n : operation === 'call' ? 0x4018n : 0x4020n,
                });
                const afterRam =
                  operation === 'call'
                    ? stack(CODE + BigInt(instruction.length / 2), 24)
                    : original;
                for (const phase of ['budget', 'stop', 'reached']) {
                  cpu.writeMemory(0x4000n, hex(original));
                  cpu.setState(before);
                  const budget = phase === 'budget' ? 1n : 2n;
                  const result = await cpu.run(
                    phase === 'stop' ? { budget, stop: target } : { budget },
                  );
                  const reason =
                    phase !== 'reached'
                      ? phase
                      : destination === 'unsupported'
                        ? 'unsupported'
                        : 'fetch-fault';
                  exit(result, reason, budget, 1n, after);
                  if (reason === 'fetch-fault') {
                    const address = destination === 'truncated' ? target + 1n : target;
                    fault(result, {
                      instructionPc: target,
                      address,
                      width: 1,
                      access: 'execute',
                      cause: destination === 'nx' ? 'permission' : 'unmapped',
                      failingAddress: address,
                    });
                  } else noFault(result);
                  memory(cpu, 0x4000n, afterRam);
                  memory(cpu, CODE, code);
                }
              },
              { ram: original },
            );
          }
      },
    },
  ];
}
