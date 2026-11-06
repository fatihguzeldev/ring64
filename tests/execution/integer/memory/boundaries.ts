import {
  createFixture,
  type Scenario,
  CODE,
  changed,
  equal,
  exit,
  fault,
  memory,
} from '../../../support/fixture.js';
import { frame, input, noFault } from './fixture.js';

export function boundaryScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createFixture(core);
  return [
    {
      name: 'integer memory failures retain full state and distinguish write intent from reads',
      run: async () => {
        const packets: {
          code: string;
          pointer: bigint;
          width: number;
          access: 'read' | 'write';
          cause: 'permission' | 'unmapped' | 'noncanonical' | 'address-range';
          failing: bigint;
          pc?: bigint;
          ramBase?: bigint;
          ram?: string;
        }[] = [
          {
            code: '48830b000100000000000000',
            pointer: 0x1004n,
            width: 8,
            access: 'write',
            cause: 'permission',
            failing: 0x1004n,
          },
          {
            code: '48830b00',
            pc: 0x2004n,
            ramBase: 0x2000n,
            ram: '11223344',
            pointer: 0x2002n,
            width: 8,
            access: 'write',
            cause: 'permission',
            failing: 0x2004n,
          },
          {
            code: '48833b00',
            pc: 0x2004n,
            ramBase: 0x2000n,
            ram: '11223344',
            pointer: 0x2002n,
            width: 8,
            access: 'read',
            cause: 'unmapped',
            failing: 0x2008n,
          },
          {
            code: '480303',
            pointer: 0x7000n,
            width: 8,
            access: 'read',
            cause: 'unmapped',
            failing: 0x7000n,
          },
          {
            code: '48f70300000000',
            pointer: 0x7000n,
            width: 8,
            access: 'read',
            cause: 'unmapped',
            failing: 0x7000n,
          },
          {
            code: '480103',
            ram: '1122334455',
            pointer: 0x4002n,
            width: 8,
            access: 'write',
            cause: 'unmapped',
            failing: 0x4005n,
          },
          {
            code: '0103',
            pointer: 0x7ffffffffffen,
            width: 4,
            access: 'write',
            cause: 'noncanonical',
            failing: 0x800000000000n,
          },
          {
            code: '480103',
            pointer: 0xfffffffffffffffen,
            width: 8,
            access: 'write',
            cause: 'address-range',
            failing: 1n << 64n,
          },
        ];
        for (const packet of packets) {
          const pc = packet.pc ?? CODE;
          const ramBase = packet.ramBase ?? 0x4000n;
          const ram = packet.ram ?? 'a5'.repeat(64);
          await using(
            packet.code,
            async (cpu) => {
              const before = input(pc, { 3: packet.pointer });
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              exit(result, 'data-fault', 1n, 0n, before);
              fault(result, {
                instructionPc: pc,
                address: packet.pointer,
                width: packet.width,
                access: packet.access,
                cause: packet.cause,
                failingAddress: packet.failing,
              });
              memory(cpu, ramBase, ram);
              memory(cpu, pc, packet.code);
            },
            { codeBase: pc, ramBase, ram },
          );
        }
      },
    },
    {
      name: 'every integer memory family preserves incoming AF on a failed full-width operand',
      run: async () => {
        for (const operation of [
          { code: '0103', access: 'write' },
          { code: '0303', access: 'read' },
          { code: '2903', access: 'write' },
          { code: '2b03', access: 'read' },
          { code: '3903', access: 'read' },
          { code: '3b03', access: 'read' },
          { code: '2103', access: 'write' },
          { code: '2303', access: 'read' },
          { code: '0903', access: 'write' },
          { code: '0b03', access: 'read' },
          { code: '3103', access: 'write' },
          { code: '3303', access: 'read' },
          { code: '8503', access: 'read' },
          { code: '830300', access: 'write' },
          { code: '832b00', access: 'write' },
          { code: '833b00', access: 'read' },
          { code: '832300', access: 'write' },
          { code: '830b00', access: 'write' },
          { code: '833300', access: 'write' },
          { code: 'f70300000000', access: 'read' },
        ] as const)
          for (const width of [32, 64]) {
            const code = `${width === 64 ? '48' : ''}${operation.code}`;
            await using(
              code,
              async (cpu) => {
                const before = input(CODE, { 0: 0x5566778880000103n, 3: 0x7000n }, 0x8d7n);
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n });
                exit(result, 'data-fault', 1n, 0n, before);
                fault(result, {
                  instructionPc: CODE,
                  address: 0x7000n,
                  width: width / 8,
                  access: operation.access,
                  cause: 'unmapped',
                  failingAddress: 0x7000n,
                });
                memory(cpu, 0x4000n, 'a5'.repeat(64));
              },
              { ramBase: 0x4000n, ram: 'a5'.repeat(64) },
            );
          }
      },
    },
    {
      name: 'identity memory writes still require write permission before changing logical flags',
      run: async () => {
        for (const instruction of ['48830b00', '488323ff', '48830300']) {
          const code = instruction + '0100000000000000';
          await using(
            code,
            async (cpu) => {
              const pointer = CODE + BigInt(instruction.length / 2);
              const before = input(CODE, { 3: pointer });
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              exit(result, 'data-fault', 1n, 0n, before);
              fault(result, {
                instructionPc: CODE,
                address: pointer,
                width: 8,
                access: 'write',
                cause: 'permission',
                failingAddress: pointer,
              });
              memory(cpu, CODE, code);
              memory(cpu, 0x4000n, 'a5'.repeat(64));
            },
            { ramBase: 0x4000n, ram: 'a5'.repeat(64) },
          );
        }
      },
    },
    {
      name: 'budget and stop precede admission and access for reached integer memory operations',
      run: async () => {
        for (const code of ['48832300', '48f70300000000'])
          await using(
            code,
            async (cpu) => {
              const before = input(CODE, { 3: 0x7000n });
              cpu.setState(before);
              const zero = await cpu.run({ budget: 0n, stop: CODE });
              exit(zero, 'budget', 0n, 0n, before);
              noFault(zero);
              equal(
                zero.resources.compilations,
                0,
                'zero budget does not compile a memory operation',
              );
              const stopped = await cpu.run({ budget: 1n, stop: CODE });
              exit(stopped, 'stop', 1n, 0n, before);
              noFault(stopped);
              equal(
                stopped.resources.compilations,
                0,
                'reached stop does not compile a memory operation',
              );
              memory(cpu, 0x4000n, 'a5'.repeat(64));
            },
            { ramBase: 0x4000n, ram: 'a5'.repeat(64) },
          );
      },
    },
    {
      name: 'reached memory diagnostics precede translation caps and caps precede operand failures',
      run: async () => {
        for (const suffix of ['480116', '4801', '488104251040000001', '48f72425']) {
          const code = '488903' + suffix;
          await using(
            code,
            async (cpu) => {
              const before = input(CODE, { 0: 2n, 3: 0x4000n, 2: 3n, 6: 0x7000n });
              cpu.setState(before);
              const result = await cpu.run({ budget: 3n });
              const reason =
                suffix === '480116'
                  ? 'resource-limit'
                  : suffix === '48f72425'
                    ? 'unsupported'
                    : 'fetch-fault';
              exit(result, reason, 3n, 1n, changed(before, 0x1003n));
              equal(result.resources.compilations, 1, 'only the reached store is compiled');
              memory(cpu, 0x4000n, '02000000000000000000000000000000');
              if (reason === 'fetch-fault') {
                const missing = CODE + BigInt(code.length / 2);
                fault(result, {
                  instructionPc: 0x1003n,
                  address: missing,
                  width: 1,
                  access: 'execute',
                  cause: 'unmapped',
                  failingAddress: missing,
                });
              } else {
                noFault(result);
              }
              if (reason === 'resource-limit') {
                const resumed = await cpu.run({ budget: 1n });
                exit(resumed, 'data-fault', 1n, 0n, result.state);
                fault(resumed, {
                  instructionPc: 0x1003n,
                  address: 0x7000n,
                  width: 8,
                  access: 'write',
                  cause: 'unmapped',
                  failingAddress: 0x7000n,
                });
                memory(cpu, 0x4000n, '02000000000000000000000000000000');
              }
            },
            {
              ramBase: 0x4000n,
              ram: '00'.repeat(16),
              limits: { maxInstructions: 1, maxTranslationsPerRun: 1 },
            },
          );
        }
      },
    },
    {
      name: 'integer memory required suffix bytes precede operand checks and unsupported selectors',
      run: async () => {
        for (const full of [
          '4f018ca5f8ffffff',
          '4803848b01000000',
          '4883848bf0ffffff01',
          '4881242510400000ffffffff',
          '48f7848b0100000000000000',
        ])
          for (let length = 1; length < full.length / 2; length++) {
            const code = full.slice(0, length * 2);
            await using(
              code,
              async (cpu) => {
                const before = input(CODE, { 3: 0x7000n, 1: 0n, 13: 0x7000n, 12: 0n });
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n });
                exit(result, 'fetch-fault', 1n, 0n, before);
                const missing = CODE + BigInt(length);
                fault(result, {
                  instructionPc: CODE,
                  address: missing,
                  width: 1,
                  access: 'execute',
                  cause: 'unmapped',
                  failingAddress: missing,
                });
                equal(
                  result.resources.compilations,
                  0,
                  'required byte failure precedes translation',
                );
                memory(cpu, 0x5000n, 'a5');
              },
              { ramBase: 0x5000n, ram: 'a5' },
            );
          }
        for (const code of [
          'c134',
          'c034',
          'f70c',
          'f624',
          'f62c',
          'f724',
          'f72c',
          'f734',
          'f73c',
          'f7e0',
          'f7e8',
          'f7f0',
          '66f723',
          '670303',
          'f00103',
          'f30103',
          '260103',
          '48490303',
          'f623',
          'f7f8',
        ])
          await using(
            code,
            async (cpu) => {
              const before = input(CODE, { 3: 0x800000000000n });
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              exit(result, 'unsupported', 1n, 0n, before);
              noFault(result);
              equal(result.resources.compilations, 0, 'unsupported form precedes data admission');
              memory(cpu, 0x4000n, frame('0100000000000000'));
            },
            { ramBase: 0x4000n, ram: frame('0100000000000000') },
          );
      },
    },
  ];
}
