import {
  using,
  snapshot,
  initial,
  equal,
  same,
  type Scenario,
} from '../exception-delivery/fixture.js';
export function operandScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'hardware debug scalar direction observes actual reads and identity writes',
      async run() {
        const cases = [
          ['8b03', 0x3000n, 3, 1],
          ['8b03', 0x3000n, 1, 0],
          ['8903', 0x3000n, 1, 1],
          ['833b00', 0x3000n, 1, 0],
          ['833b00', 0x3000n, 3, 1],
          ['0f4403', 0x3000n, 3, 1],
          ['0fb10b', 0x3000n, 1, 1],
          ['c12300', 0x3000n, 1, 1],
          ['0fa303', 0x3004n, 3, 1],
          ['8d03', 0x3000n, 3, 0],
          ['0f180b', 0x3000n, 3, 0],
          ['0fae3b', 0x3000n, 3, 0],
          ['8b03', 0x3000n, 2, 0],
        ] as const;
        for (const [code, address, rw, mask] of cases)
          await using(
            compiler,
            code,
            snapshot(),
            async (cpu) => {
              cpu.setDebugState({
                addresses: [address, 0n, 0n, 0n],
                dr6: 0n,
                dr7: 0x401n | (BigInt(rw) << 16n),
              });
              cpu.setState(initial(0x1000n, { 0: 32n, 1: 9n, 3: 0x3000n }, 0x202n));
              const r = await cpu.run({ budget: 1n });
              equal(
                r.reason,
                mask ? 'debug-exception' : 'budget',
                `opcode ${code} direction ${rw}`,
              );
              equal(r.retired, 1n, 'completed operand');
              equal(
                cpu.readDebugState().dr6,
                0xffff0ff0n | BigInt(mask),
                'only actual selected footprint',
              );
              if (code === '0fb10b' || code === 'c12300')
                same(
                  cpu.readMemory(0x3000n, 4),
                  new Uint8Array([1, 0, 0, 0]),
                  'identity write still matches',
                );
              if (code === '0f4403')
                equal(r.state.registers[0], 32n, 'false CMOV leaves destination');
            },
            { data: [{ base: 0x3000n, bytes: '0100000001000000' }] },
          );
      },
    },
    {
      name: 'hardware debug near CALL combines pointer read and committed stack write before successor stop',
      async run() {
        await using(
          compiler,
          'ff13',
          snapshot(),
          async (cpu) => {
            cpu.setDebugState({ addresses: [0x3000n, 0x7ff8n, 0n, 0n], dr6: 0n, dr7: 0x009b0405n });
            cpu.setState(initial(0x1000n, { 3: 0x3000n, 4: 0x8000n }, 0x202n));
            const r = await cpu.run({ budget: 1n, stop: 0x2000n });
            equal(r.reason, 'debug-exception', 'completed data trap beats stop');
            equal(r.retired, 1n, 'CALL retirement');
            equal(r.state.rip, 0x2000n, 'target prepared');
            equal(r.debugException?.breakpoints, 3, 'pointer and stack candidates merged');
            equal(r.state.registers[4], 0x7ff8n, 'push committed');
            same(
              cpu.readMemory(0x7ff8n, 8),
              new Uint8Array([2, 16, 0, 0, 0, 0, 0, 0]),
              'return PC stored',
            );
          },
          {
            data: [
              { base: 0x3000n, bytes: '0020000000000000' },
              { base: 0x7ff8n, bytes: '00'.repeat(8) },
              { base: 0x2000n, bytes: '90', execute: true },
            ],
          },
        );
      },
    },
    {
      name: 'hardware debug instruction faults and failed REP elements discard unpublished operand hits',
      async run() {
        for (const [code, regs, data, reason] of [
          ['f733', { 3: 0x3000n }, [{ base: 0x3000n, bytes: '00000000' }], 'divide-error'],
          [
            'f3a4',
            { 1: 1n, 6: 0x3000n, 7: 0x4000n },
            [{ base: 0x3000n, bytes: '01' }],
            'data-fault',
          ],
        ] as const)
          await using(
            compiler,
            code + '90',
            snapshot(),
            async (cpu) => {
              cpu.setDebugState({ addresses: [0x3000n, 0n, 0n, 0n], dr6: 0n, dr7: 0x30401n });
              cpu.setState(initial(0x1000n, regs, 0x202n));
              const r = await cpu.run({ budget: 1n });
              equal(r.reason, reason, 'fault beats candidate');
              equal(r.retired, 0n, 'failed instruction');
              equal(cpu.readDebugState().dr6, 0xffff0ff0n, 'no status publication');
              equal(r.state.debugContinuation, undefined, 'no durable uncommitted candidate');
              cpu.setState({ ...r.state, rip: 0x1000n + BigInt(code.length / 2) });
              const n = await cpu.run({ budget: 1n });
              equal(n.reason, 'budget', 'candidate cannot leak into next run');
            },
            { data: [...data] },
          );
      },
    },
    {
      name: 'hardware debug data-only partial REP traps before repeat quota and retains exact element continuation',
      async run() {
        for (const direction of [false, true])
          await using(
            compiler,
            'f3a4',
            snapshot(),
            async (cpu) => {
              cpu.setDebugState({
                addresses: [direction ? 0x3001n : 0x3000n, 0n, 0n, 0n],
                dr6: 0n,
                dr7: 0x30401n,
              });
              cpu.setState(
                initial(
                  0x1000n,
                  { 1: 2n, 6: direction ? 0x3001n : 0x3000n, 7: direction ? 0x4001n : 0x4000n },
                  direction ? 0x602n : 0x202n,
                ),
              );
              const r = await cpu.run({ budget: 1n, repeatBudget: 1n });
              equal(r.reason, 'debug-exception', 'data trap before quota');
              equal(r.repeatIterations, 1n, 'one element');
              equal(r.retired, 0n, 'partial instruction');
              equal(r.state.rip, 0x1000n, 'restart PC');
              equal(r.state.registers[1], 1n, 'remaining count');
              equal(r.debugException?.instructionCompleted, false, 'partial source');
              equal(
                r.debugException?.resumeFlags,
                (direction ? 0x602n : 0x202n) | 0x10000n,
                'partial saved RF',
              );
              equal(r.state.flags, direction ? 0x602n : 0x202n, 'live RF remains clear');
              const next = await cpu.run({ budget: 1n });
              equal(next.reason, 'budget', 'unwatched second element completes');
              equal(next.retired, 1n, 'whole instruction charged once');
            },
            {
              data: [
                { base: 0x3000n, bytes: '0102' },
                { base: 0x4000n, bytes: '0000' },
              ],
            },
          );
      },
    },
  ];
}
