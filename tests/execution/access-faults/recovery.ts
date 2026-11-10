import {
  using,
  snapshot,
  initial,
  loadedCode,
  loadedData,
  withGate,
  gate,
  CODE32,
  CODE64,
  DATA32,
  STACK,
  FILL,
  image,
  encoded,
  same,
  equal,
  ready,
  delivery,
  createCpu,
  LIMITS,
  hex,
  type Scenario,
} from '../exception-delivery/fixture.js';
import { TSS } from '../software-events/fixture.js';

export function recoveryScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'architectural access illegal LOCK is patched through an executable alias and IRET retries revised bytes once',
      async run() {
        const context = snapshot('protected');
        context.segments.cs = loadedCode(32);
        context.segments.ss = loadedData(32);
        const address = withGate(context, 6);
        const data = [
          { base: 0x4008n, bytes: CODE32 + DATA32 },
          { base: address, bytes: gate(32, 8, 0x2000n, 0) },
          { base: 0x2000n, bytes: 'c6050060000090cf', execute: true },
          { base: STACK, bytes: FILL },
        ];
        const cpu = await createCpu({
          compiler,
          context,
          entry: 0x1000n,
          limits: LIMITS,
          memory: {
            backings: [
              { id: 'code', bytes: hex('f090') },
              ...data.map((d, i) => ({ id: `d${i}`, bytes: hex(d.bytes) })),
            ],
            mappings: [
              {
                base: 0x1000n,
                backing: 'code',
                offset: 0,
                length: 2,
                permissions: { read: true, write: false, execute: true },
              },
              {
                base: 0x6000n,
                backing: 'code',
                offset: 0,
                length: 2,
                permissions: { read: true, write: true, execute: true },
              },
              ...data.map((d, i) => ({
                base: d.base,
                backing: `d${i}`,
                offset: 0,
                length: d.bytes.length / 2,
                permissions: { read: true, write: true, execute: d.execute ?? false },
              })),
            ],
          },
          memoryLimits: { maxBackings: 8, maxMappings: 8, maxBackingBytes: 1024 },
        });
        try {
          cpu.setState(initial(0x1000n, { 4: 0x8000n }, 0x202n));
          const result = await cpu.run({ budget: 3n, eventDelivery: { budget: 2n } });
          delivery(result, 'budget', 3n, 1n, 1n);
          ready(result);
          equal(result.state.rip, 0x1001n, 'repaired byte is the retried instruction');
          equal(result.state.flags, 0x202n, 'retry consumes RF');
          same(cpu.readMemory(0x1000n, 2), hex('9090'), 'executable alias patch');
          same(
            cpu.readMemory(0x7ff4n, 12),
            image([0x1000n, 8n, 0x10202n], 4),
            '#UD has no error slot',
          );
          same(cpu.readMemory(STACK, 244), new Uint8Array(244).fill(0xa5), 'whole lower guard');
        } finally {
          cpu.dispose();
        }
      },
    },
    {
      name: 'architectural access alignment and guest null-DS handlers repair operands then IRET retries with exact GP frames',
      async run() {
        for (const nullDs of [false, true]) {
          const execution = snapshot('protected');
          execution.segments.cs = loadedCode(32);
          execution.segments.ss = loadedData(32);
          const address = withGate(execution, 13);
          await using(
            compiler,
            nullDs ? '31c08ed88b03' : '0f2803',
            execution,
            async (cpu) => {
              cpu.setState(initial(0x1000n, { 3: nullDs ? 0x6000n : 0x6001n, 4: 0x8000n }, 0x202n));
              const result = await cpu.run({
                budget: nullDs ? 7n : 4n,
                eventDelivery: { budget: 2n },
              });
              delivery(result, 'budget', nullDs ? 7n : 4n, 1n, 1n);
              ready(result);
              equal(result.state.rip, nullDs ? 0x1006n : 0x1003n, 'successful retry continuation');
              equal(
                result.state.registers[4],
                0x8000n,
                'error slot discarded and source SP restored',
              );
              same(
                cpu.readMemory(0x7ff0n, 16),
                image([0n, nullDs ? 0x1004n : 0x1000n, 8n, nullDs ? 0x10246n : 0x10202n], 4),
                'literal GP0 frame',
              );
              if (nullDs) {
                equal(cpu.readContext().segments.ds.selector, 16, 'guest reload repairs cache');
                equal(result.state.registers[0], 0x1122334404030201n, 'retried data value');
              } else
                equal(
                  cpu.readXmmState()[0],
                  0x100f0e0d0c0b0a090807060504030201n,
                  'aligned retry vector',
                );
            },
            {
              data: [
                { base: 0x4008n, bytes: CODE32 + DATA32 },
                { base: address, bytes: gate(32, 8, 0x2000n, 0) },
                {
                  base: 0x2000n,
                  bytes: (nullDs ? '66b810008ed8' : 'bb00600000') + '83c404cf',
                  execute: true,
                },
                { base: 0x6000n, bytes: '0102030405060708090a0b0c0d0e0f10' },
                { base: STACK, bytes: FILL },
              ],
            },
          );
        }
      },
    },
    {
      name: 'architectural access SS and GP noncanonical operands recover on IST and restore the repaired source stack',
      async run() {
        for (const ss of [false, true]) {
          const execution = snapshot();
          execution.segments.cs = loadedCode(64);
          execution.segments.ss = loadedData(32);
          execution.tr = TSS;
          const address = withGate(execution, ss ? 12 : 13);
          await using(
            compiler,
            ss ? '488b0424' : '488b03',
            execution,
            async (cpu) => {
              const oldSp = ss ? 0x800000000000n : 0x9000n;
              cpu.setState(initial(0x1000n, { 3: 0x800000000000n, 4: oldSp }, 0x202n));
              const result = await cpu.run({ budget: 4n, eventDelivery: { budget: 2n } });
              delivery(result, 'budget', 4n, 1n, 1n);
              ready(result);
              equal(result.state.registers[0], 0x0807060504030201n, 'retried qword');
              equal(
                result.state.registers[4],
                ss ? 0x6000n : oldSp,
                'repaired or preserved raw SP',
              );
              same(
                cpu.readMemory(0x7fd0n, 48),
                image([0n, 0x1000n, 8n, 0x10202n, ss ? 0x6000n : oldSp, 16n], 8),
                'literal six-qword IST fault frame',
              );
            },
            {
              data: [
                { base: 0x4008n, bytes: CODE64 + DATA32 },
                { base: address, bytes: gate(64, 8, 0x2000n, 0, false, 1) },
                { base: 0x5024n, bytes: encoded(image([0x8000n], 8)) },
                {
                  base: 0x2000n,
                  bytes: (ss ? '48c744242000600000' : 'bb00600000') + '4883c40848cf',
                  execute: true,
                },
                { base: 0x6000n, bytes: '0102030405060708' },
                { base: STACK, bytes: FILL },
              ],
            },
          );
        }
      },
    },
    {
      name: 'architectural access REP completed elements survive fault and guest cache reload resumes only remaining work',
      async run() {
        const execution = snapshot('protected');
        execution.segments.cs = loadedCode(32);
        execution.segments.ss = loadedData(32);
        execution.segments.ds.limit = 0x6001;
        const address = withGate(execution, 13);
        await using(
          compiler,
          'f3a4',
          execution,
          async (cpu) => {
            cpu.setState(initial(0x1000n, { 1: 4n, 6: 0x6000n, 7: 0x7000n, 4: 0x8000n }, 0x202n));
            const fault = await cpu.run({
              budget: 1n,
              repeatBudget: 4n,
              eventDelivery: { budget: 0n },
            });
            delivery(fault, 'event-budget', 0n, 0n, 0n);
            equal(fault.repeatIterations, 2n, 'two committed elements');
            equal(fault.state.registers[1], 2n, 'remaining count');
            equal(fault.state.registers[6], 0x6002n, 'remaining source');
            same(cpu.readMemory(0x7000n, 4), hex('0102a5a5'), 'partial publication');
            const result = await cpu.run({
              budget: 5n,
              repeatBudget: 2n,
              eventDelivery: { budget: 1n },
            });
            delivery(result, 'budget', 5n, 1n, 0n);
            ready(result);
            equal(result.repeatIterations, 2n, 'no replayed elements');
            equal(result.state.registers[1], 0n, 'complete count');
            same(cpu.readMemory(0x7000n, 4), hex('01020304'), 'remaining writes');
            same(
              cpu.readMemory(0x7ff0n, 16),
              image([0n, 0x1000n, 8n, 0x10202n], 4),
              'REP source PC',
            );
          },
          {
            data: [
              { base: 0x4008n, bytes: CODE32 + DATA32 },
              { base: address, bytes: gate(32, 8, 0x2000n, 0) },
              { base: 0x2000n, bytes: '66b810008ed883c404cf', execute: true },
              { base: 0x6000n, bytes: '01020304' },
              { base: 0x7000n, bytes: 'a5'.repeat(4) },
              { base: STACK, bytes: FILL },
            ],
          },
        );
      },
    },
  ];
}
