import type { X87State } from '../../../host/index.js';
import {
  ONE,
  INDEFINITE,
  NUMERIC_STATUS,
  LONG,
  raw,
  integer,
  stack,
  slot,
  clone,
  pop,
  environment,
  seed,
  other,
  x87,
  noFault,
  using,
  input,
  changed,
  outcome,
  memory,
  bytes,
  type Scenario,
} from './fixture.js';

interface Packet {
  code: string;
  before: X87State;
  after: X87State;
  data?: string;
  stored?: string;
}

export function literalScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'x87 floating and signed integer memory arithmetic selectors preserve format widths reverse order and comparison pops',
      async run() {
        for (const [opcode, data] of [
          [0xd8, '00000040'],
          [0xdc, '0000000000000040'],
          [0xda, '02000000'],
          [0xde, '0200'],
        ] as const) {
          for (let selector = 0; selector < 8; selector++) {
            const state = stack({ 0: integer(4n) }, 0, 0x37f, 0x200),
              expected = clone(state);
            expected.statusWord = 0;
            const values = [
              integer(6n),
              integer(8n),
              integer(4n),
              integer(4n),
              integer(2n),
              integer(-2n),
              integer(2n),
              raw(0x3ffe),
            ];
            if (selector !== 2 && selector !== 3) slot(expected, 0, values[selector]!);
            if (selector === 3) pop(expected);
            const code = `${opcode.toString(16)}${((selector << 3) | 3).toString(16).padStart(2, '0')}`;
            await using(
              compiler,
              code,
              LONG,
              async (cpu) => {
                const before = input(0x1000n, { 3: 0x6000n });
                cpu.setState(before);
                seed(cpu, state);
                const result = await cpu.run({ budget: 1n });
                outcome(result, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1002n));
                x87(
                  cpu,
                  environment(expected, 0x1000n, 0x6000n),
                  selector === 2 || selector === 3 ? 0xffff : NUMERIC_STATUS,
                );
                other(cpu);
                noFault(result);
                memory(cpu, 0x6000n, data);
              },
              { data: [{ base: 0x6000n, bytes: data }] },
            );
          }
        }
      },
    },
    {
      name: 'x87 signed integer memory conversions cover exact endpoints invalid indefinite and suppressed unmasked stores',
      async run() {
        for (const [width, load] of [
          [16, 'df03'],
          [32, 'db03'],
          [64, 'df2b'],
        ] as const) {
          for (const value of [-(1n << BigInt(width - 1)), (1n << BigInt(width - 1)) - 1n]) {
            const data = bytes(BigInt.asUintN(width, value), width / 8),
              state = stack({}, 0, 0x7f),
              expected = clone(state);
            slot(expected, 7, integer(value));
            expected.statusWord = 0x3800;
            await using(
              compiler,
              load,
              LONG,
              async (cpu) => {
                const before = input(0x1000n, { 3: 0x6000n });
                cpu.setState(before);
                seed(cpu, state);
                const result = await cpu.run({ budget: 1n });
                outcome(result, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1002n));
                x87(cpu, environment(expected, 0x1000n, 0x6000n), NUMERIC_STATUS);
                other(cpu);
                noFault(result);
                memory(cpu, 0x6000n, data);
              },
              { data: [{ base: 0x6000n, bytes: data }] },
            );
          }
        }
        for (const [width, code, popped, fop] of [
          [16, 'df13', false, 0x713],
          [16, 'df1b', true, 0x71b],
          [32, 'db13', false, 0x313],
          [32, 'db1b', true, 0x31b],
          [64, 'df3b', true, 0x73b],
        ] as const) {
          for (const invalid of [false, true])
            for (const masked of invalid ? [false, true] : [true]) {
              const value = invalid ? 1n << BigInt(width - 1) : -7n,
                state = stack({ 0: integer(value) }, 0, masked ? 0x37f : 0x37e),
                expected = clone(state);
              expected.statusWord = invalid ? (masked ? 1 : 0x8081) : 0;
              if (popped && (!invalid || masked)) pop(expected);
              const stored =
                invalid && !masked
                  ? 'a5'.repeat(width / 8)
                  : bytes(
                      invalid ? 1n << BigInt(width - 1) : BigInt.asUintN(width, -7n),
                      width / 8,
                    );
              await using(
                compiler,
                code,
                LONG,
                async (cpu) => {
                  const before = input(0x1000n, { 3: 0x6000n });
                  cpu.setState(before);
                  seed(cpu, state);
                  const result = await cpu.run({ budget: 1n });
                  outcome(result, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1002n));
                  x87(
                    cpu,
                    environment(expected, 0x1000n, 0x6000n, invalid && !masked ? fop : undefined),
                    NUMERIC_STATUS,
                  );
                  other(cpu);
                  noFault(result);
                  memory(cpu, 0x6000n, stored);
                },
                { data: [{ base: 0x6000n, bytes: 'a5'.repeat(width / 8) }] },
              );
            }
        }
      },
    },
    {
      name: 'x87 arithmetic register directions pop aliases and every TOP use exact independent integer results',
      async run() {
        for (const [opcode, base, result, alias, destination, pops] of [
          [0xd8, 0xc0, integer(6n), integer(8n), false, false],
          [0xd8, 0xc8, integer(8n), integer(16n), false, false],
          [0xd8, 0xe0, integer(2n), 0n, false, false],
          [0xd8, 0xe8, integer(-2n), 0n, false, false],
          [0xd8, 0xf0, integer(2n), ONE, false, false],
          [0xd8, 0xf8, raw(0x3ffe), ONE, false, false],
          [0xdc, 0xc0, integer(6n), integer(8n), true, false],
          [0xdc, 0xc8, integer(8n), integer(16n), true, false],
          [0xdc, 0xe0, integer(2n), 0n, true, false],
          [0xdc, 0xe8, integer(-2n), 0n, true, false],
          [0xdc, 0xf0, integer(2n), ONE, true, false],
          [0xdc, 0xf8, raw(0x3ffe), ONE, true, false],
          [0xde, 0xc0, integer(6n), integer(8n), true, true],
          [0xde, 0xc8, integer(8n), integer(16n), true, true],
          [0xde, 0xe0, integer(2n), 0n, true, true],
          [0xde, 0xe8, integer(-2n), 0n, true, true],
          [0xde, 0xf0, integer(2n), ONE, true, true],
          [0xde, 0xf8, raw(0x3ffe), ONE, true, true],
        ] as const)
          for (const index of [0, 1, 7])
            for (let top = 0; top < 8; top++) {
              const state = stack({ 0: integer(4n), [index]: integer(index === 0 ? 4n : 2n) }, top),
                expected = clone(state);
              slot(expected, (top + (destination ? index : 0)) & 7, index === 0 ? alias : result);
              if (pops) pop(expected);
              const code = `${opcode.toString(16)}${(base + index).toString(16)}`;
              await using(compiler, code, LONG, async (cpu) => {
                const before = input();
                cpu.setState(before);
                seed(cpu, state);
                const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
                outcome(result, 'budget', 1n, 1n, 0n, 0n, changed(before, 0x1002n));
                x87(cpu, environment(expected), NUMERIC_STATUS);
                other(cpu);
                noFault(result);
              });
            }
      },
    },
    {
      name: 'x87 raw register moves exchange free rotations and unary operations preserve physical payload ownership',
      async run() {
        for (let top = 0; top < 8; top++)
          for (const code of [
            'd9c0',
            'd9c9',
            'ddd1',
            'ddd9',
            'ddc1',
            'd9f6',
            'd9f7',
            'd9e0',
            'd9e1',
            'd9e4',
            'd9d0',
          ]) {
            const state = stack({ 0: integer(-4n), 1: integer(2n) }, top, 0x37f, 0x200),
              expected = clone(state);
            expected.statusWord &= ~0x200;
            if (code === 'd9c0') {
              const pushed = (top + 7) & 7;
              slot(expected, pushed, state.registers[top]!);
              expected.statusWord = pushed << 11;
            } else if (code === 'd9c9') {
              slot(expected, top, integer(2n));
              slot(expected, (top + 1) & 7, integer(-4n));
            } else if (code === 'ddd1' || code === 'ddd9') {
              slot(expected, (top + 1) & 7, integer(-4n));
              if (code === 'ddd9') pop(expected);
            } else if (code === 'ddc1') {
              expected.tagWord |= 3 << (((top + 1) & 7) * 2);
              expected.statusWord = state.statusWord;
            } else if (code === 'd9f6' || code === 'd9f7')
              expected.statusWord = ((top + (code === 'd9f6' ? 7 : 1)) & 7) << 11;
            else if (code === 'd9e0' || code === 'd9e1') slot(expected, top, integer(4n));
            else if (code === 'd9e4') expected.statusWord = (top << 11) | 0x100;
            else if (code === 'd9d0') expected.statusWord = state.statusWord;
            await using(compiler, code, LONG, async (cpu) => {
              const before = input();
              cpu.setState(before);
              seed(cpu, state);
              const result = await cpu.run({ budget: 1n });
              outcome(result, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1002n));
              x87(cpu, environment(expected), code === 'd9e4' ? 0xffff : NUMERIC_STATUS);
              other(cpu);
              noFault(result);
            });
          }
      },
    },
    {
      name: 'x87 square root and round-to-integer obey direct precision and rounding while retaining the extended range',
      async run() {
        const packets: Packet[] = [];
        {
          const before = stack({ 0: integer(2n) }),
            after = clone(before);
          slot(after, 0, raw(0x3fff, 0xb504f333f9de6484n));
          after.statusWord = 0x20;
          packets.push({ code: 'd9fa', before, after: environment(after) });
        }
        for (const [rc, result, status] of [
          [0, 2n, 0x220],
          [1, 1n, 0x20],
          [2, 2n, 0x220],
          [3, 1n, 0x20],
        ] as const) {
          const before = stack({ 0: raw(0x3fff, 0xc000000000000000n) }, 0, 0x7f | (rc << 10)),
            after = clone(before);
          slot(after, 0, integer(result));
          after.statusWord = status;
          packets.push({ code: 'd9fc', before, after: environment(after) });
        }
        {
          const before = stack({ 0: raw(0x4027, 0x8000000000600000n) }, 0, 0x7f),
            after = clone(before);
          slot(after, 0, integer((1n << 40n) + 1n));
          after.statusWord = 0x220;
          packets.push({ code: 'd9fc', before, after: environment(after) });
        }
        for (const packet of packets)
          await using(compiler, packet.code, LONG, async (cpu) => {
            const before = input();
            cpu.setState(before);
            seed(cpu, packet.before);
            const result = await cpu.run({ budget: 1n });
            outcome(result, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1002n));
            x87(cpu, packet.after, NUMERIC_STATUS);
            other(cpu);
            noFault(result);
          });
      },
    },
    {
      name: 'x87 literal arithmetic packets distinguish exact raw80 PC precision and extended exponent range',
      async run() {
        const packets: Packet[] = [];
        for (const [cw, value, status] of [
          [0x37f, raw(0x3fff, 0x8000000000000008n), 0],
          [0x27f, ONE, 0x20],
          [0x7f, ONE, 0x20],
          [0xa7f, raw(0x3fff, 0x8000000000000800n), 0x220],
          [0x17f, raw(0x3fff, 0x8000000000000008n), 0],
        ] as const) {
          const before = stack({ 0: ONE, 1: raw(0x3fc3) }, 0, cw),
            after = clone(before);
          slot(after, 0, value);
          after.statusWord = status;
          packets.push({ code: 'd8c1', before, after: environment(after) });
        }
        {
          const before = stack({ 0: raw(0x43fe), 1: raw(0x43fe) }, 0, 0x27f),
            after = clone(before);
          slot(after, 0, raw(0x43ff));
          packets.push({ code: 'd8c1', before, after: environment(after) });
        }
        {
          const before = stack({ 0: ONE, 1: raw(0xbffe, 0xfffffffffffffffen) }, 0, 0x7f),
            after = clone(before);
          slot(after, 0, raw(0x3fc0));
          packets.push({ code: 'd8c1', before, after: environment(after) });
        }
        for (const [cw, result, status] of [
          [0x377, raw(0x1fff, 0xffffffffffffffffn), 0x8088],
          [0x36f, raw(0x6000), 0x8090],
        ] as const) {
          const before =
            cw === 0x377
              ? stack({ 0: raw(0x7ffe, 0xffffffffffffffffn), 1: raw(0x4000) }, 0, cw)
              : stack({ 0: raw(1), 1: raw(0x3ffe) }, 0, cw);
          const after = clone(before);
          slot(after, 0, result);
          after.statusWord = status;
          packets.push({
            code: 'd8c9',
            before,
            after: environment(after, 0x1000n, undefined, 0xc9),
          });
        }
        for (const packet of packets)
          await using(compiler, packet.code, LONG, async (cpu) => {
            const before = input(0x1000n, {}, 0xcd7n);
            cpu.setState(before);
            seed(cpu, packet.before);
            const result = await cpu.run({ budget: 1n, repeatBudget: 7n });
            outcome(result, 'budget', 1n, 1n, 7n, 0n, changed(before, 0x1002n));
            x87(cpu, packet.after, NUMERIC_STATUS);
            other(cpu);
            noFault(result);
          });
      },
    },
    {
      name: 'x87 literal loads stores and conversions preserve exact integer raw80 and instruction-specific pending effects',
      async run() {
        const packets: Packet[] = [];
        {
          const before = stack({}, 0, 0x7f),
            after = clone(before);
          slot(after, 7, raw(0x4034, 0x8000000000000400n));
          after.statusWord = 0x3800;
          packets.push({
            code: 'df2b',
            before,
            after: environment(after, 0x1000n, 0x6000n),
            data: '0100000000002000',
          });
        }
        {
          const before = stack({ 0: raw(0x3fff, 0x8000008000000001n) }),
            after = clone(before);
          pop(after);
          after.statusWord |= 0x220;
          packets.push({
            code: 'd91b',
            before,
            after: environment(after, 0x1000n, 0x6000n),
            data: 'a5a5a5a5',
            stored: '0100803f',
          });
        }
        {
          const before = stack({ 0: raw(0x3fff, 0xc000000000000000n) }, 0, 0x35f),
            after = clone(before);
          pop(after);
          after.statusWord |= 0x82a0;
          packets.push({
            code: 'db1b',
            before,
            after: environment(after, 0x1000n, 0x6000n, 0x31b),
            data: 'a5a5a5a5',
            stored: '02000000',
          });
        }
        {
          const before = stack({ 0: raw(0x7fff) }, 0, 0x37e),
            after = clone(before);
          after.statusWord = 0x8081;
          packets.push({
            code: 'db1b',
            before,
            after: environment(after, 0x1000n, 0x6000n, 0x31b),
            data: 'a5a5a5a5',
            stored: 'a5a5a5a5',
          });
        }
        for (const [cw, value, status] of [
          [0x377, raw(0x407f), 0x8088],
          [0x36f, raw(0x3f69), 0x8090],
        ] as const) {
          const before = stack({ 0: value }, 0, cw),
            after = clone(before);
          after.statusWord = status;
          packets.push({
            code: 'd91b',
            before,
            after: environment(after, 0x1000n, 0x6000n, 0x11b),
            data: 'a5a5a5a5',
            stored: 'a5a5a5a5',
          });
        }
        {
          const before = stack({}, 0, 0x37d),
            after = clone(before);
          slot(after, 7, raw(0x3f6a));
          after.statusWord = 0xb882;
          packets.push({
            code: 'd903',
            before,
            after: environment(after, 0x1000n, 0x6000n, 0x103),
            data: '01000000',
          });
        }
        {
          const before = stack(),
            after = clone(before);
          slot(after, 7, 1n);
          after.statusWord = 0x3800;
          packets.push({
            code: 'db2b',
            before,
            after: environment(after, 0x1000n, 0x6000n),
            data: '01000000000000000000',
          });
        }
        for (const packet of packets)
          await using(
            compiler,
            packet.code,
            LONG,
            async (cpu) => {
              const before = input(0x1000n, { 3: 0x6000n }, 0xcd7n);
              cpu.setState(before);
              seed(cpu, packet.before);
              const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
              outcome(result, 'budget', 1n, 1n, 0n, 0n, changed(before, 0x1002n));
              x87(cpu, packet.after, NUMERIC_STATUS);
              other(cpu);
              noFault(result);
              memory(cpu, 0x6000n, packet.stored ?? packet.data!);
            },
            { data: [{ base: 0x6000n, bytes: packet.data! }] },
          );
      },
    },
    {
      name: 'x87 literal stack overflow empty-sign classification and ordered versus unordered comparisons expose raw state',
      async run() {
        {
          const before = stack(Object.fromEntries(Array.from({ length: 8 }, (_, i) => [i, ONE]))),
            after = clone(before);
          slot(after, 7, INDEFINITE);
          after.statusWord = 0x3a41;
          await using(compiler, 'd9e8', LONG, async (cpu) => {
            const scalar = input();
            cpu.setState(scalar);
            seed(cpu, before);
            const result = await cpu.run({ budget: 1n });
            outcome(result, 'budget', 1n, 1n, 1n, 0n, changed(scalar, 0x1002n));
            x87(cpu, environment(after), NUMERIC_STATUS);
            other(cpu);
            noFault(result);
          });
        }
        {
          const before = stack();
          before.registers[0] = raw(0x8000, 0n);
          const after = clone(before);
          after.statusWord = 0x4300;
          await using(compiler, 'd9e5', LONG, async (cpu) => {
            const scalar = input();
            cpu.setState(scalar);
            seed(cpu, before);
            const result = await cpu.run({ budget: 1n });
            outcome(result, 'budget', 1n, 1n, 1n, 0n, changed(scalar, 0x1002n));
            x87(cpu, environment(after));
            other(cpu);
            noFault(result);
          });
        }
        for (const [code, invalid, flags, popped, cw] of [
          ['d8d1', true, 0xcd7n, false, 0x37f],
          ['dde1', false, 0xcd7n, false, 0x37f],
          ['dff1', true, 0x447n, true, 0x37f],
          ['dfe9', false, 0x447n, true, 0x37f],
          ['dff1', true, 0x402n, false, 0x37e],
        ] as const) {
          const before = stack({ 0: raw(0x7fff, 0xc000000000000011n), 1: ONE }, 0, cw),
            after = clone(before);
          const flagForm = code.startsWith('df');
          after.statusWord =
            (invalid ? 1 : 0) | (invalid && cw === 0x37e ? 0x8080 : 0) | (!flagForm ? 0x4500 : 0);
          if (popped) pop(after);
          const fop = invalid && cw === 0x37e ? 0x7f1 : undefined;
          await using(compiler, code, LONG, async (cpu) => {
            const scalar = input(0x1000n, {}, cw === 0x37e ? 0xc92n : 0xcd7n);
            cpu.setState(scalar);
            seed(cpu, before);
            const result = await cpu.run({ budget: 1n });
            outcome(result, 'budget', 1n, 1n, 1n, 0n, changed(scalar, 0x1002n, {}, flags));
            x87(cpu, environment(after, 0x1000n, undefined, fop));
            other(cpu);
            noFault(result);
          });
        }
      },
    },
  ];
}
