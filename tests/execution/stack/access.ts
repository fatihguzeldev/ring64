import { type Scenario, CODE, changed, equal, exit, fault, memory } from '../../support/fixture.js';
import { FLAGS, RAM, createStackFixture, input, noFault, stack } from './fixture.js';

export function accessScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createStackFixture(core);
  return [
    {
      name: 'stack and dynamic-target failures preserve each incoming flag and all partial effects',
      run: async () => {
        const rows = [
          {
            code: 'ffd0',
            registers: { 0: 0x800000000000n, 4: 0x7000n },
            address: 0x800000000000n,
            access: 'execute',
            cause: 'noncanonical',
            failing: 0x800000000000n,
          },
          {
            code: 'ffd0',
            registers: { 0: 0x1010n, 4: 0x7000n },
            address: 0x6ff8n,
            access: 'write',
            cause: 'unmapped',
            failing: 0x6ff8n,
          },
          {
            code: '50',
            registers: { 4: 0x1008n },
            address: 0x1000n,
            access: 'write',
            cause: 'permission',
            failing: 0x1000n,
          },
          ...['c3', 'c2ffff'].flatMap((code) => [
            {
              code,
              registers: { 4: 0x7000n },
              address: 0x7000n,
              access: 'read' as const,
              cause: 'unmapped' as const,
              failing: 0x7000n,
            },
            {
              code,
              top: 0x800000000000n,
              registers: {},
              address: 0x800000000000n,
              access: 'execute' as const,
              cause: 'noncanonical' as const,
              failing: 0x800000000000n,
            },
          ]),
          {
            code: '47ffe4',
            registers: { 12: 0x800000000000n, 4: 0x7000n },
            address: 0x800000000000n,
            access: 'execute',
            cause: 'noncanonical',
            failing: 0x800000000000n,
          },
          {
            code: '50',
            registers: { 4: 1n },
            address: 0xfffffffffffffff9n,
            access: 'write',
            cause: 'address-range',
            failing: 0x10000000000000000n,
          },
          {
            code: '58',
            registers: { 4: 0x7ffffffffffcn },
            address: 0x7ffffffffffcn,
            access: 'read',
            cause: 'noncanonical',
            failing: 0x800000000000n,
          },
        ] as const;
        for (const row of rows) {
          const original = 'top' in row ? stack(row.top) : RAM;
          await using(
            row.code,
            async (cpu) => {
              for (const flags of FLAGS) {
                const before = input(CODE, row.registers, flags);
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n });
                exit(
                  result,
                  row.access === 'execute' ? 'target-fault' : 'data-fault',
                  1n,
                  0n,
                  before,
                );
                fault(result, {
                  instructionPc: CODE,
                  address: row.address,
                  width: row.access === 'execute' ? 0 : 8,
                  access: row.access,
                  cause: row.cause,
                  failingAddress: row.failing,
                });
                if (flags !== FLAGS[0])
                  equal(
                    result.resources.compilations,
                    0,
                    'faulting artifact retains fresh imported flags',
                  );
                memory(cpu, 0x4000n, original);
                memory(cpu, CODE, row.code);
              }
            },
            { ram: original },
          );
        }
      },
    },
    {
      name: 'stack writes validate the complete span before touching an accessible prefix',
      run: async () => {
        for (const row of [
          {
            code: '50',
            pc: CODE,
            sp: 0x4008n,
            ramBase: 0x4000n,
            ram: 'a5'.repeat(4),
            address: 0x4000n,
            access: 'write',
            cause: 'unmapped',
            failing: 0x4004n,
          },
          {
            code: '58',
            pc: CODE,
            sp: 0x4000n,
            ramBase: 0x4000n,
            ram: 'a5'.repeat(4),
            address: 0x4000n,
            access: 'read',
            cause: 'unmapped',
            failing: 0x4004n,
          },
          {
            code: '50',
            pc: 0x4004n,
            sp: 0x4008n,
            ramBase: 0x4000n,
            ram: 'a5'.repeat(4),
            address: 0x4000n,
            access: 'write',
            cause: 'permission',
            failing: 0x4004n,
          },
          {
            code: 'ffd0',
            pc: 0x4004n,
            sp: 0x4008n,
            ramBase: 0x4000n,
            ram: 'a5'.repeat(4),
            address: 0x4000n,
            access: 'write',
            cause: 'permission',
            failing: 0x4004n,
          },
          {
            code: '50',
            pc: CODE,
            sp: 0x800000000004n,
            ramBase: 0x4000n,
            ram: RAM,
            address: 0x7ffffffffffcn,
            access: 'write',
            cause: 'noncanonical',
            failing: 0x800000000000n,
          },
          {
            code: 'c3',
            pc: CODE,
            sp: 0xfffffffffffffffen,
            ramBase: 0x4000n,
            ram: RAM,
            address: 0xfffffffffffffffen,
            access: 'read',
            cause: 'address-range',
            failing: 0x10000000000000000n,
          },
        ] as const) {
          await using(
            row.code,
            async (cpu) => {
              const before = input(row.pc, { 0: 0x1010n, 4: row.sp });
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              exit(result, 'data-fault', 1n, 0n, before);
              fault(result, {
                instructionPc: row.pc,
                address: row.address,
                width: 8,
                access: row.access,
                cause: row.cause,
                failingAddress: row.failing,
              });
              memory(cpu, row.ramBase, row.ram);
              memory(cpu, row.pc, row.code);
            },
            { codeBase: row.pc, ramBase: row.ramBase, ram: row.ram },
          );
        }
      },
    },
    {
      name: 'POP and RET accept readable RX and adjacent spans without requiring write permission',
      run: async () => {
        for (const code of ['581010000000000000', 'c31010000000000000', '58101000', 'c3101000']) {
          const adjacent = code.length === 8;
          const original = adjacent ? '00'.repeat(5) + 'a5'.repeat(8) : RAM;
          const ramBase = adjacent ? 0x1004n : 0x4000n;
          await using(
            code,
            async (cpu) => {
              const before = input(CODE, { 4: 0x1001n });
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              exit(
                result,
                'budget',
                1n,
                1n,
                changed(
                  before,
                  code.startsWith('58') ? 0x1001n : 0x1010n,
                  code.startsWith('58') ? { 0: 0x1010n, 4: 0x1009n } : { 4: 0x1009n },
                ),
              );
              noFault(result);
              memory(cpu, CODE, code);
              memory(cpu, ramBase, original);
            },
            { ramBase, ram: original },
          );
        }
      },
    },
    {
      name: 'high unaligned and wrapping stack pointers validate only the bytes actually accessed',
      run: async () => {
        for (const row of [
          {
            code: '50',
            base: 0xffff800000004000n,
            length: 64,
            offset: 24,
            sp: 0xffff800000004020n,
            after: 0xffff800000004018n,
            push: true,
          },
          {
            code: '58',
            base: 0xffff800000004000n,
            length: 64,
            offset: 32,
            sp: 0xffff800000004020n,
            after: 0xffff800000004028n,
            push: false,
          },
          {
            code: 'c3',
            base: 0xffff800000004000n,
            length: 64,
            offset: 32,
            sp: 0xffff800000004020n,
            after: 0xffff800000004028n,
            push: false,
          },
          {
            code: '50',
            base: 0x4000n,
            length: 32,
            offset: 3,
            sp: 0x400bn,
            after: 0x4003n,
            push: true,
          },
          {
            code: '58',
            base: 0x4000n,
            length: 32,
            offset: 3,
            sp: 0x4003n,
            after: 0x400bn,
            push: false,
          },
          {
            code: 'c3',
            base: 0x4000n,
            length: 32,
            offset: 3,
            sp: 0x4003n,
            after: 0x400bn,
            push: false,
          },
          {
            code: '50',
            base: 0xfffffffffffffff8n,
            length: 8,
            offset: 0,
            sp: 0n,
            after: 0xfffffffffffffff8n,
            push: true,
          },
          {
            code: '58',
            base: 0xfffffffffffffff8n,
            length: 8,
            offset: 0,
            sp: 0xfffffffffffffff8n,
            after: 0n,
            push: false,
          },
          {
            code: 'c3',
            base: 0xfffffffffffffff8n,
            length: 8,
            offset: 0,
            sp: 0xfffffffffffffff8n,
            after: 0n,
            push: false,
          },
          {
            code: 'c2ffff',
            base: 0xfffffffffffffff8n,
            length: 8,
            offset: 0,
            sp: 0xfffffffffffffff8n,
            after: 0xffffn,
            push: false,
          },
          {
            code: '54',
            base: 0x7ffffffffff0n,
            length: 16,
            offset: 8,
            sp: 0x800000000000n,
            after: 0x7ffffffffff8n,
            push: true,
          },
          {
            code: '58',
            base: 0x7ffffffffff8n,
            length: 8,
            offset: 0,
            sp: 0x7ffffffffff8n,
            after: 0x800000000000n,
            push: false,
          },
          {
            code: 'c3',
            base: 0x7ffffffffff8n,
            length: 8,
            offset: 0,
            sp: 0x7ffffffffff8n,
            after: 0x800000000000n,
            push: false,
          },
          {
            code: 'c20100',
            base: 0x7ffffffffff8n,
            length: 8,
            offset: 0,
            sp: 0x7ffffffffff8n,
            after: 0x800000000001n,
            push: false,
          },
        ]) {
          const original = row.push
            ? 'a5'.repeat(row.length)
            : stack(0x1010n, row.offset, row.length);
          await using(
            row.code,
            async (cpu) => {
              const before = input(CODE, { 0: 0xfedcba9876543210n, 4: row.sp });
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              exit(
                result,
                'budget',
                1n,
                1n,
                changed(
                  before,
                  row.code.startsWith('c') ? 0x1010n : CODE + 1n,
                  row.code === '58' ? { 0: 0x1010n, 4: row.after } : { 4: row.after },
                ),
              );
              noFault(result);
              memory(
                cpu,
                row.base,
                row.push
                  ? stack(row.code === '54' ? row.sp : 0xfedcba9876543210n, row.offset, row.length)
                  : original,
              );
              memory(cpu, CODE, row.code);
            },
            { ramBase: row.base, ram: original },
          );
        }
      },
    },
  ];
}
