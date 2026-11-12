import {
  OLD_SP,
  SOURCE,
  TARGET,
  NEW_SP,
  complete,
  equal,
  initial,
  little,
  preserveNumeric,
  scalar,
  usingGate,
  write,
  type Scenario,
} from './fixture.js';

export function basicGateScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'call gate32 literal privilege frame and RETF byte cleanup preserve captured caller banks',
      async run() {
        await usingGate(compiler, { count: 3, targetCode: 'ca0c00' }, async (cpu) => {
          const numeric = preserveNumeric(cpu);
          for (const [index, value] of [0xa1n, 0xb2n, 0xc3n].entries())
            write(cpu, OLD_SP + BigInt(index * 4), little(value, 4));
          const before = initial(SOURCE, { 4: OLD_SP }, 0x402n);
          cpu.setState(before);
          const entered = await cpu.run({ budget: 1n, repeatBudget: 0n });
          complete(entered);
          equal(entered.state.rip, TARGET, 'gate target ignores encoded offset');
          equal(entered.state.registers[4], 0x8fe4n, 'seven dword frame slots');
          equal(cpu.readContext().cpl, 0, 'inner target CPL');
          equal(cpu.readContext().segments.cs.selector, 8, 'loaded target CS');
          equal(cpu.readContext().segments.ss.selector, 16, 'loaded target SS');
          const expected = [0x1007n, 0x1bn, 0xa1n, 0xb2n, 0xc3n, 0x4000n, 0x23n];
          for (const [index, value] of expected.entries())
            equal(
              scalar(cpu, 0x8fe4n + BigInt(index * 4), 4),
              value,
              'literal frame slot ' + index,
            );
          equal(entered.state.flags, 0x402n, 'DF/IF preserved without FLAGS slot');
          const returned = await cpu.run({ budget: 1n, repeatBudget: 0n });
          complete(returned);
          equal(returned.state.rip, 0x1007n, 'saved completed caller PC');
          equal(returned.state.registers[4], 0x400cn, 'both-stack unsigned cleanup');
          equal(cpu.readContext().cpl, 3, 'outer caller CPL');
          equal(cpu.readContext().segments.cs.selector, 0x1b, 'caller CS restored');
          equal(cpu.readContext().segments.ss.selector, 0x23, 'caller SS restored');
          for (let bank = 0; bank < 16; bank++)
            if (bank !== 4)
              equal(
                returned.state.registers[bank],
                before.registers[bank],
                'unrelated GPR ' + bank,
              );
          numeric();
        });
      },
    },
    {
      name: 'call gate32 parameter width is independent of operand16 and target code size',
      async run() {
        await usingGate(
          compiler,
          { code: '669a34123b00', count: 1, targetCode: 'ca0400' },
          async (cpu) => {
            cpu.setState(initial(SOURCE, { 4: OLD_SP }, 2n));
            write(cpu, OLD_SP, little(0x12345678n, 4));
            const entered = await cpu.run({ budget: 1n });
            complete(entered);
            equal(entered.state.registers[4], NEW_SP - 20n, 'five dword slots despite operand16');
            equal(scalar(cpu, NEW_SP - 20n, 4), 0x1006n, 'complete six-byte source return');
            equal(scalar(cpu, NEW_SP - 12n, 4), 0x12345678n, 'dword parameter');
            const returned = await cpu.run({ budget: 1n });
            complete(returned);
            equal(returned.state.rip, 0x1006n, 'operand16 source next PC');
            equal(returned.state.registers[4], OLD_SP + 4n, 'dword cleanup');
          },
        );
      },
    },
  ];
}
