import { createCpu } from '../../host/index.js';
import {
  createFixture,
  type Scenario,
  CODE,
  DATA,
  LIMITS,
  FRAME,
  equal,
  hex,
  memory,
  initial,
  changed,
  state,
  exit,
  throws,
  rejects,
} from '../execution/fixture.js';

export function embeddingScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createFixture(core);
  return [
    {
      name: 'pending execution rejects concurrent observations, mutation and disposal',
      run: async () => {
        await using('b801000000', async (cpu) => {
          const input = initial();
          cpu.setState(input);
          const pending = cpu.run({ budget: 1n });
          const second = rejects(() => cpu.run({ budget: 1n }), 'concurrent run');
          try {
            throws(() => cpu.setState(input), 'pending state import');
            throws(() => cpu.readState(), 'pending state read');
            throws(() => cpu.readMemory(DATA, 8), 'pending memory read');
            throws(() => cpu.writeMemory(DATA, new Uint8Array(8)), 'pending memory write');
            throws(() => cpu.dispose(), 'pending disposal');
            await second;
          } finally {
            exit(await pending, 'budget', 1n, 1n, changed(input, CODE + 5n, { 0: 1n }));
          }
        });
      },
    },
    {
      name: 'owned images and returned state have no mutable external aliases',
      run: async () => {
        const code = hex('b801000000');
        const ram = hex(FRAME);
        const cpu = await createCpu({
          compiler: core,
          code: { base: CODE, bytes: code },
          ram: { base: DATA - 8n, bytes: ram },
          limits: LIMITS,
        });
        try {
          code.fill(0xf4);
          ram.fill(0);
          const input = initial();
          const expected = changed(input, CODE + 5n, { 0: 1n });
          cpu.setState(input);
          input.registers[9] = 0n;
          const snapshot = cpu.readState();
          snapshot.registers[10] = 0n;
          snapshot.flags = 0n;
          cpu.readMemory(DATA - 8n, 24).fill(0);
          const result = await cpu.run({ budget: 1n });
          exit(result, 'budget', 1n, 1n, expected);
          result.state.registers[11] = 0n;
          result.state.rip = 0n;
          state(cpu.readState(), expected);
          memory(cpu, DATA - 8n, FRAME);
        } finally {
          cpu.dispose();
        }
      },
    },
    {
      name: 'malformed invocation inputs reject without corrupting idle state',
      run: async () => {
        await using('b801000000', async (cpu) => {
          const input = initial();
          cpu.setState(input);
          for (const flags of [0n, 0x202n, 0x402n, 1n << 64n]) {
            throws(() => cpu.setState({ ...input, flags }), 'invalid imported flags');
            state(cpu.readState(), input);
          }
          throws(
            () => cpu.setState({ ...input, registers: input.registers.slice(0, 15) }),
            'short register bank',
          );
          const invalidRegisters = [...input.registers];
          invalidRegisters[7] = -1n;
          throws(
            () => cpu.setState({ ...input, registers: invalidRegisters }),
            'negative raw register',
          );
          for (const value of [-1n, 1n << 64n]) {
            await rejects(() => cpu.run({ budget: value }), 'out-of-range budget');
            await rejects(() => cpu.run({ budget: 1n, stop: value }), 'out-of-range stop');
            state(cpu.readState(), input);
          }
          const maximum = (1n << 64n) - 1n;
          const result = await cpu.run({ budget: maximum, stop: CODE });
          exit(result, 'stop', maximum, 0n, input);
          equal(
            result.resources.compilations,
            0,
            'maximum raw budget preserves a stop before admission',
          );
          memory(cpu, DATA - 8n, FRAME);
        });
      },
    },
  ];
}
