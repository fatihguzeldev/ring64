import {
  createCpu,
  using,
  snapshot,
  initial,
  loadedCode,
  loadedData,
  withGate,
  gate,
  CODE32,
  DATA32,
  STACK,
  FILL,
  LIMITS,
  hex,
  image,
  same,
  equal,
  check,
  ready,
  delivery,
  preserveNumeric,
  type Scenario,
} from './fixture.js';

export function memoryScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'late denied exception error slot publishes neither frame nor descriptor accessed update and can be repaired',
      async run() {
        const execution = snapshot('protected');
        execution.segments.cs = loadedCode(32);
        execution.segments.ss = loadedData(32);
        const address = withGate(execution, 13);
        const descriptor = 'ffff0000009acf00';
        const code = hex('0fae1500600000');
        const permissions = { read: true, write: true, execute: false };
        const mappings = [
          {
            base: 0x1000n,
            backing: 'code',
            offset: 0,
            length: code.length,
            permissions: { read: true, write: false, execute: true },
          },
          { base: 0x4008n, backing: 'descriptor', offset: 0, length: 8, permissions },
          { base: address, backing: 'gate', offset: 0, length: 8, permissions },
          { base: 0x6000n, backing: 'operand', offset: 0, length: 4, permissions },
          { base: STACK, backing: 'stack', offset: 0, length: 243, permissions },
          {
            base: 0x7ff3n,
            backing: 'stack',
            offset: 243,
            length: 1,
            permissions: { ...permissions, write: false },
          },
          { base: 0x7ff4n, backing: 'stack', offset: 244, length: 12, permissions },
        ];
        const cpu = await createCpu({
          compiler,
          context: execution,
          entry: 0x1000n,
          limits: LIMITS,
          memoryLimits: { maxBackings: 5, maxMappings: 7, maxBackingBytes: 300 },
          memory: {
            backings: [
              { id: 'code', bytes: code },
              { id: 'descriptor', bytes: hex(descriptor) },
              { id: 'gate', bytes: hex(gate(32, 8, 0x2000n, 0)) },
              { id: 'operand', bytes: hex('00000100') },
              { id: 'stack', bytes: hex(FILL) },
            ],
            mappings,
          },
        });
        try {
          const numeric = preserveNumeric(cpu);
          cpu.setState(initial(0x1000n, { 4: 0x8000n }, 0x202n));
          const refused = await cpu.run({ budget: 1n, exceptionDelivery: { budget: 1n } });
          delivery(refused, 'data-fault', 0n, 1n, 0n);
          equal(refused.fault?.instructionPc, 0x1000n, 'entry failure source');
          equal(refused.fault?.address, 0x7ff0n, 'error slot is final prepared write');
          equal(refused.fault?.width, 4, 'nominal error slot width');
          equal(refused.fault?.failingAddress, 0x7ff3n, 'denied error tail byte');
          same(cpu.readMemory(STACK, 256), hex(FILL), 'no partial frame publication');
          same(cpu.readMemory(0x4008n, 8), hex(descriptor), 'no early accessed write');
          same(cpu.readContext(), execution, 'failed entry leaves loaded caches');
          check(refused.state.event.kind === 'pending', 'source retained across private refusal');
          equal(refused.state.event.exception.vector, 13, 'source did not become #DF');
          equal(refused.state.event.exception.errorCode, 0, 'source #GP zero code');
          cpu.setMappings(
            mappings.map((mapping) =>
              mapping.base === 0x7ff3n ? { ...mapping, permissions } : mapping,
            ),
          );
          const resumed = await cpu.run({
            budget: 1n,
            stop: 0x2000n,
            exceptionDelivery: { budget: 1n },
          });
          delivery(resumed, 'stop', 0n, 1n, 0n);
          ready(resumed);
          same(
            cpu.readMemory(0x7ff0n, 16),
            image([0n, 0x1000n, 8n, 0x10202n], 4),
            'repaired whole frame',
          );
          same(
            cpu.readMemory(0x4008n, 8),
            hex(CODE32),
            'accessed byte commits after all admission',
          );
          numeric();
        } finally {
          cpu.dispose();
        }
      },
    },
    {
      name: 'automatic frame source alias invalidates a warmed middle entry before newly written bytes execute',
      async run() {
        const execution = snapshot('protected');
        execution.segments.cs = loadedCode(32);
        execution.segments.ss = loadedData(32);
        const address = withGate(execution, 0);
        const code = hex('90f7f1900000');
        const cpu = await createCpu({
          compiler,
          context: execution,
          entry: 0x10b7n,
          limits: LIMITS,
          memoryLimits: { maxBackings: 4, maxMappings: 6, maxBackingBytes: 64 },
          memory: {
            backings: [
              { id: 'code', bytes: code },
              { id: 'descriptor', bytes: hex(CODE32) },
              { id: 'gate', bytes: hex(gate(32, 8, 0x2000n, 0)) },
              { id: 'frame', bytes: hex('a5'.repeat(8)) },
            ],
            mappings: [
              {
                base: 0x10b7n,
                backing: 'code',
                offset: 0,
                length: code.length,
                permissions: { read: true, write: false, execute: true },
              },
              {
                base: 0x4008n,
                backing: 'descriptor',
                offset: 0,
                length: 8,
                permissions: { read: true, write: false, execute: false },
              },
              {
                base: address,
                backing: 'gate',
                offset: 0,
                length: 8,
                permissions: { read: true, write: false, execute: false },
              },
              {
                base: 0x7ff4n,
                backing: 'code',
                offset: 1,
                length: 4,
                permissions: { read: false, write: true, execute: false },
              },
              {
                base: 0x7ff8n,
                backing: 'frame',
                offset: 0,
                length: 8,
                permissions: { read: true, write: true, execute: false },
              },
              {
                base: 0x9000n,
                backing: 'frame',
                offset: 0,
                length: 8,
                permissions: { read: true, write: false, execute: false },
              },
            ],
          },
        });
        try {
          cpu.setState(initial(0x10b7n, { 0: 6n, 1: 0n, 2: 0n, 4: 0x8000n }, 0x202n));
          const warm = await cpu.run({ budget: 1n });
          equal(warm.state.rip, 0x10b8n, 'warmed DIV middle entry');
          const owners = cpu.inspectTranslations().map((unit) => unit.owner);
          check(owners.length > 0, 'warmed executable owner retained');
          const entered = await cpu.run({
            budget: 1n,
            stop: 0x2000n,
            exceptionDelivery: { budget: 1n },
          });
          delivery(entered, 'stop', 0n, 1n, 0n);
          ready(entered);
          same(
            cpu.readMemory(0x10b7n, code.length),
            hex('90b810000000'),
            'return-PC write changes source backing through write-only alias',
          );
          same(cpu.readMemory(0x9000n, 8), image([8n, 0x10202n], 4), 'remaining captured slots');
          check(
            !cpu.inspectTranslations().some((unit) => owners.includes(unit.owner)),
            'mutated source owner is retired',
          );
          cpu.setState(initial(0x10b8n, { 0: 6n, 1: 0n, 2: 0n, 4: 0x8000n }, 0x202n));
          const replaced = await cpu.run({ budget: 1n, exceptionDelivery: { budget: 1n } });
          delivery(replaced, 'budget', 1n, 0n, 1n);
          equal(replaced.state.registers[0], 16n, 'new MOV executes instead of stale divide error');
          equal(replaced.state.rip, 0x10bdn, 'new five-byte instruction continuation');
        } finally {
          cpu.dispose();
        }
      },
    },
    {
      name: 'automatic entry committed before translation refusal is resumed at the handler without a second frame',
      async run() {
        const execution = snapshot('protected');
        execution.segments.cs = loadedCode(32, 0x18);
        execution.segments.ss = loadedData(32);
        const address = withGate(execution, 6);
        await using(
          compiler,
          '900f0b90',
          execution,
          async (cpu) => {
            const numeric = preserveNumeric(cpu);
            cpu.setState(initial(0x1000n, { 4: 0x8000n }, 0x202n));
            const entered = await cpu.run({ budget: 2n, exceptionDelivery: { budget: 1n } });
            delivery(entered, 'resource-limit', 1n, 1n, 0n);
            ready(entered);
            equal(
              entered.state.rip,
              0x2000n,
              'committed handler PC survives unavailable compilation',
            );
            equal(entered.state.registers[4], 0x7ff4n, 'one frame was committed');
            const frame = cpu.readMemory(0x7ff4n, 12);
            same(frame, image([0x1001n, 0x18n, 0x10202n], 4), 'committed source frame');
            const resumed = await cpu.run({ budget: 1n, exceptionDelivery: { budget: 1n } });
            delivery(resumed, 'budget', 1n, 0n, 1n);
            ready(resumed);
            equal(
              resumed.state.registers[0],
              0x1122334400000005n,
              'handler body executes once with legacy raw high bits preserved',
            );
            equal(resumed.state.rip, 0x2005n, 'handler continuation');
            equal(resumed.state.registers[4], 0x7ff4n, 'no replayed push');
            same(cpu.readMemory(0x7ff4n, 12), frame, 'frame retained across translation refusal');
            numeric();
          },
          {
            limits: { maxTranslationsPerRun: 1 },
            data: [
              { base: 0x4008n, bytes: CODE32 + DATA32 + CODE32 },
              { base: address, bytes: gate(32, 8, 0x2000n, 0) },
              { base: 0x2000n, bytes: 'b80500000090', execute: true },
              { base: STACK, bytes: FILL },
            ],
          },
        );
      },
    },
    {
      name: 'handler-first-instruction fault loops exhaust delivery work without retiring instructions or inventing #DF',
      async run() {
        const execution = snapshot('protected');
        execution.segments.cs = loadedCode(32);
        execution.segments.ss = loadedData(32);
        const address = withGate(execution, 0);
        await using(
          compiler,
          'f7f1',
          execution,
          async (cpu) => {
            cpu.setState(initial(0x1000n, { 0: 6n, 1: 0n, 2: 0n, 4: 0x8000n }, 0x202n));
            const result = await cpu.run({ budget: 1n, exceptionDelivery: { budget: 3n } });
            delivery(result, 'event-budget', 0n, 3n, 0n);
            equal(result.state.rip, 0x2000n, 'fresh handler fault source');
            equal(result.state.registers[4], 0x7fdcn, 'three independently committed frames');
            same(
              result.state.event,
              {
                kind: 'pending',
                exception: {
                  vector: 0,
                  instructionPc: 0x2000n,
                  returnPc: 0x2000n,
                  savedFlags: 0x10002n,
                },
              },
              'post-entry fault starts a fresh contributory chain',
            );
            same(
              cpu.readMemory(0x7fdcn, 36),
              image([0x2000n, 8n, 0x10002n, 0x2000n, 8n, 0x10002n, 0x1000n, 8n, 0x10202n], 4),
              'exact bounded stack progress',
            );
            equal(
              result.resources.compilations,
              2,
              'stable handler reused without translation growth',
            );
          },
          {
            data: [
              { base: 0x4008n, bytes: CODE32 + DATA32 },
              { base: address, bytes: gate(32, 8, 0x2000n, 0) },
              { base: 0x2000n, bytes: 'f7f1', execute: true },
              { base: STACK, bytes: FILL },
            ],
          },
        );
      },
    },
  ];
}
