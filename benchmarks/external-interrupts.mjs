const CODE = 0x1000n;
const HANDLER = CODE + 32n;
const RAM = 0x4000n;
const RAM_BYTES = 0x5000;
const GDT = 0x4100n;
const IDT = 0x4200n;
const STACK = 0x8000n;
const EMPTY = { irq: null, nmiPending: false, nmiBlocked: false };
const LIMITS = {
  maxInstructions: 128,
  maxSourceBytes: 2048,
  maxArtifactBytes: 262144,
  maxCachedArtifacts: 32,
  maxCachedBytes: 4194304,
  maxTranslationsPerRun: 32,
};
const encode = (v) =>
  JSON.stringify(v, (_, x) => {
    if (typeof x === 'bigint') return x.toString();
    if (x !== null && typeof x === 'object' && !Array.isArray(x))
      return Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)));
    return x;
  });
function equal(actual, expected, label) {
  if (encode(actual) !== encode(expected))
    throw Error(`${label}: ${encode(actual)} != ${encode(expected)}`);
}
function put(bytes, address, value, width = 4) {
  const at = Number(address - RAM);
  for (let i = 0; i < width; i++) bytes[at + i] = Number((value >> BigInt(i * 8)) & 255n);
}
const rows = [
  ...['masked-irq-loop', 'blocked-nmi-loop', 'masked-irq-resume'].flatMap((kind) =>
    [false, true].map((queued) => ({
      name: `external-${kind}-${queued ? 'queued' : 'empty'}`,
      kind,
      control: true,
      queued,
    })),
  ),
  ...[
    'irq-iret',
    'nmi-iret',
    'sti-hlt-irq',
    'halted-nmi-wakeup',
    'nmi-pending-resume',
    'irq-private-idt-repair',
    'iret-private-unblock',
    'rep-idle-reentry',
    'shutdown-nmi-wakeup',
    'executable-frame-alias',
  ].map((kind) => ({ name: `external-${kind}`, kind })),
];
export const externalInterruptNames = rows.map((row) => row.name);
const isNmi = (row) =>
  row.kind.includes('nmi') ||
  row.kind === 'iret-private-unblock' ||
  row.kind === 'executable-frame-alias';
function program(row) {
  const bytes = new Uint8Array(64).fill(0x82);
  bytes.set(
    row.control
      ? [0x83, 0xc0, 1, 0xe2, 0xfb]
      : row.kind === 'sti-hlt-irq'
        ? [0xfb, 0xf4]
        : row.kind === 'halted-nmi-wakeup'
          ? [0xf4]
          : row.kind === 'iret-private-unblock'
            ? [0xcf]
            : row.kind === 'rep-idle-reentry'
              ? [0xf3, 0xa4]
              : [0x90],
  );
  bytes[32] = 0xcf;
  return bytes;
}
function memory() {
  const bytes = new Uint8Array(RAM_BYTES).fill(0xa5);
  bytes.set([255, 255, 0, 0, 0, 0x9b, 0xcf, 0, 255, 255, 0, 0, 0, 0x93, 0xcf, 0], 0x108);
  for (const vector of [2, 0x20]) {
    const at = IDT + BigInt(8 * vector);
    put(bytes, at, HANDLER, 2);
    put(bytes, at + 2n, 8n, 2);
    put(bytes, at + 4n, 0n, 1);
    put(bytes, at + 5n, 0x8en, 1);
    put(bytes, at + 6n, 0n, 2);
  }
  bytes[0x2000] = 0x11;
  bytes[0x2001] = 0x22;
  return bytes;
}
function mappings(row, denied = false) {
  const code = {
    base: CODE,
    backing: 'code',
    offset: 0,
    length: 64,
    permissions: { read: true, write: false, execute: true },
  };
  const part = (offset, length, read = true) => ({
    base: RAM + BigInt(offset),
    backing: 'ram',
    offset,
    length,
    permissions: { read, write: true, execute: false },
  });
  if (row.kind === 'executable-frame-alias')
    return [
      code,
      part(0, 0x3ff4),
      { ...part(0x3ff4, 12), backing: 'code', offset: 0 },
      part(0x4000, RAM_BYTES - 0x4000),
    ];
  if (row.kind === 'iret-private-unblock')
    return [code, part(0, 0x4000), part(0x4000, 12, false), part(0x400c, RAM_BYTES - 0x400c)];
  if (denied) return [code, part(0, 0x300), part(0x300, 8, false), part(0x308, RAM_BYTES - 0x308)];
  return [code, part(0, RAM_BYTES)];
}
function context(cpu) {
  const value = cpu.readContext();
  value.mode = 'protected';
  value.segments.cs.long = false;
  value.segments.cs.default32 = true;
  value.segments.ss.default32 = true;
  value.gdtr = { base: GDT, limit: 31 };
  value.idtr = { base: IDT, limit: 0x107 };
  cpu.setContext(value);
  return cpu.readContext();
}
function seedNumeric(cpu) {
  cpu.setXmmState(
    Array.from({ length: 16 }, (_, i) => (BigInt(i + 1) << 112n) | 0xfedcba9876543210n),
  );
  cpu.setMxcsr(0xffc5);
  cpu.setX87State({
    registers: Array.from({ length: 8 }, (_, i) => (BigInt(i + 1) << 64n) | 0x123456789abcdef0n),
    controlWord: 0x37e,
    statusWord: 0x8081,
    tagWord: 0xffff,
    opcode: 0x5a5,
    instructionPointer: 0x1122334455667788n,
    dataPointer: 0x8877665544332211n,
  });
}
const keys = ['compilations', 'cacheHits', 'nativeEntries', 'dispatches', 'generatedBytes'];
const phases = ['translationMs', 'browserCompileMs', 'instantiationMs', 'executionMs', 'totalMs'];
const totals = (fields) => Object.fromEntries(fields.map((key) => [key, 0]));
function sum(target, source) {
  for (const key of Object.keys(target)) target[key] += source[key];
}
function input(row, n) {
  const registers = Array.from({ length: 16 }, (_, i) => 0x1122334400000000n + BigInt(i));
  registers[0] = 0n;
  registers[1] = row.control ? n : row.kind === 'rep-idle-reentry' ? 2n : 3n;
  registers[4] = STACK;
  registers[6] = 0x6000n;
  registers[7] = 0x6100n;
  return {
    registers,
    rip: CODE,
    flags: row.control || isNmi(row) || row.kind === 'sti-hlt-irq' ? 2n : 0x202n,
    interruptibility: { sti: false, ss: row.kind === 'executable-frame-alias' },
    event: { kind: row.kind === 'shutdown-nmi-wakeup' ? 'shutdown' : 'ready' },
    interrupts: {
      ...EMPTY,
      nmiBlocked: row.kind === 'blocked-nmi-loop' || row.kind === 'iret-private-unblock',
    },
  };
}
function guardFaults(result, allowed) {
  for (const field of [
    'fault',
    'segmentFault',
    'alignmentFault',
    'generalProtectionFault',
    'simdException',
    'x87Exception',
    'protectionFault',
    'systemMemoryFault',
    'debugException',
  ])
    if (field !== allowed) equal(result[field], undefined, `no stale ${field}`);
}

export async function measureExternalInterrupts(
  sides,
  { iterations, samples, workloads, reverse = false },
) {
  const definitions = [],
    results = [],
    unavailable = [];
  const groups = [];
  for (const row of rows.filter((entry) => workloads.includes(entry.name))) {
    const previous = groups.at(-1);
    if (row.control && previous?.[0].kind === row.kind) previous.push(row);
    else groups.push([row]);
  }
  for (const group of groups) {
    const n = BigInt(
      Math.min(iterations, group[0].control && !group[0].kind.endsWith('resume') ? 1000001 : 1001),
    );
    for (const row of group)
      definitions.push({
        name: row.name,
        profile: 'protected32',
        code: Array.from(program(row), (b) => b.toString(16).padStart(2, '0')).join(''),
        iterations: n,
        work: row.control ? 2n * n : n,
        throughputUnit: row.control ? 'guest instructions' : 'accepted external requests',
        controlGroup: row.control ? row.kind : undefined,
        queued: row.control ? row.queued : undefined,
        order:
          'alternating sample order across sides and paired empty/queued controls; reverse changes the first order',
        timing: {
          elapsedMs:
            'sum of awaited measured run calls; excludes intake, resets, repairs and output checks',
          wallMs: 'includes per-call intake, reset, repair, private-yield preparation and checks',
        },
        ceiling:
          row.kind === 'shutdown-nmi-wakeup'
            ? 'Explicit deterministic shutdown checkpoint wake, no architectural abort recovery claim.'
            : 'Idle-only private-memory synthetic execution; no active-run or hardware arrival latency claim.',
        limits: LIMITS,
      });
    const active = [];
    try {
      for (const row of group)
        for (const side of sides) {
          if (
            !WebAssembly.Module.exports(side.compiler).some(
              (entry) => entry.name === 'core_request_interrupt',
            )
          ) {
            if (side.label === 'current')
              throw Error('current build is missing external interrupt intake');
            unavailable.push({
              side: side.label,
              workload: row.name,
              reason:
                'external IRQ/NMI/HLT lifetime unavailable; host emulation is not an equivalent baseline',
            });
            continue;
          }
          const code = program(row);
          const cpu = await side.createCpu({
            compiler: side.compiler,
            entry: CODE,
            memory: {
              backings: [
                { id: 'code', bytes: code },
                { id: 'ram', bytes: memory() },
              ],
              mappings: mappings(row),
            },
            memoryLimits: { maxBackings: 2, maxBackingBytes: RAM_BYTES + 64, maxMappings: 4 },
            limits: LIMITS,
          });
          active.push({ side, cpu, row, code, expectedContext: context(cpu) });
        }
      for (let sample = 0; sample < samples; sample++)
        for (const { side, cpu, row, code, expectedContext } of (sample + Number(reverse)) % 2
          ? [...active].reverse()
          : active) {
          const initial = input(row, n),
            bytes = memory();
          if (row.kind !== 'iret-private-unblock') cpu.writeMemory(RAM, bytes);
          else {
            cpu.writeMemory(RAM, bytes.subarray(0, 0x4000));
            cpu.writeMemory(STACK + 12n, bytes.subarray(0x400c));
          }
          if (row.kind === 'executable-frame-alias')
            cpu.writeMemory(STACK - 12n, code.subarray(0, 12));
          seedNumeric(cpu);
          const numeric = {
            xmm: cpu.readXmmState(),
            mxcsr: cpu.readMxcsr(),
            x87: cpu.readX87State(),
          };
          const resources = totals(keys),
            timings = totals(phases),
            setupResources = totals(keys),
            setupTimings = totals(phases);
          let elapsedMs = 0,
            calls = 0,
            accepted = 0n,
            attempts = 0n,
            retired = 0n,
            repeated = 0n,
            setupRetired = 0n,
            setupRepeated = 0n,
            result;
          const call = async (budget, deliveryBudget, stop) => {
            const at = performance.now();
            const output = await cpu.run({
              budget,
              repeatBudget: 0n,
              exceptionDelivery: { budget: deliveryBudget },
              ...(stop === undefined ? {} : { stop }),
            });
            elapsedMs += performance.now() - at;
            calls++;
            attempts += output.deliveryAttempts;
            retired += output.retired;
            repeated += output.repeatIterations;
            equal(
              output.deliveryAttempts + output.remainingDeliveryBudget,
              deliveryBudget,
              'entry allowance',
            );
            sum(resources, output.resources);
            sum(timings, output.timings);
            return output;
          };
          const began = performance.now();
          if (row.control) {
            cpu.setState(initial);
            if (row.queued) {
              if (row.kind === 'blocked-nmi-loop') cpu.requestNmi();
              else equal(cpu.requestInterrupt(0x20), true, 'control queue intake');
            }
            if (row.kind.endsWith('resume'))
              for (let i = 0n; i < 2n * n; i++) {
                result = await call(1n, 0n);
                equal(result.reason, 'budget', 'control resume');
                equal(result.retired, 1n, 'resume retirement');
              }
            else result = await call(2n * n, 0n);
            equal(result.reason, 'budget', 'inhibited control completes');
            equal(retired, 2n * n, 'same control work');
            equal(attempts, 0n, 'no eligible external source');
            equal(result.state.registers[0], n, 'control arithmetic');
            equal(result.state.registers[1], 0n, 'control loop count');
            equal(
              resources.nativeEntries,
              row.kind.endsWith('resume') ? 2 * Number(n) : 1,
              'no queue-induced generated invocation',
            );
            equal(resources.dispatches, 0, 'no per-instruction queue dispatch');
            equal(
              result.state.interrupts,
              {
                ...initial.interrupts,
                irq: row.queued && row.kind !== 'blocked-nmi-loop' ? 0x20 : null,
                nmiPending: row.queued && row.kind === 'blocked-nmi-loop',
              },
              'control queue state',
            );
            const expected = structuredClone(initial);
            expected.registers[0] = n;
            expected.registers[1] = 0n;
            expected.rip = CODE + 5n;
            let bits = Number(n & 255n),
              parity = 0;
            while (bits) {
              parity ^= bits & 1;
              bits >>>= 1;
            }
            expected.flags = 2n | (parity ? 0n : 4n) | (n % 16n === 0n ? 16n : 0n);
            expected.interrupts = {
              ...initial.interrupts,
              irq: row.queued && row.kind !== 'blocked-nmi-loop' ? 0x20 : null,
              nmiPending: row.queued && row.kind === 'blocked-nmi-loop',
            };
            equal(result.state, expected, 'complete control state');
            guardFaults(result);
          } else {
            for (let iteration = 0n; iteration < n; iteration++) {
              cpu.setState(initial);
              if (row.kind === 'irq-private-idt-repair') cpu.setMappings(mappings(row, true));
              if (row.kind === 'executable-frame-alias')
                cpu.writeMemory(STACK - 12n, code.subarray(0, 12));
              if (row.kind === 'halted-nmi-wakeup' || row.kind === 'rep-idle-reentry') {
                const prepared = await cpu.run({
                  budget: row.kind === 'halted-nmi-wakeup' ? 2n : 1n,
                  repeatBudget: 1n,
                });
                equal(
                  prepared.reason,
                  row.kind === 'halted-nmi-wakeup' ? 'halted' : 'repeat-budget',
                  'private preparation',
                );
                setupRetired += prepared.retired;
                setupRepeated += prepared.repeatIterations;
                sum(setupResources, prepared.resources);
                sum(setupTimings, prepared.timings);
              }
              if (isNmi(row)) cpu.requestNmi();
              else equal(cpu.requestInterrupt(0x20), true, 'empty slot intake');
              if (row.kind === 'nmi-pending-resume') {
                result = await call(1n, 0n);
                equal(result.reason, 'event-budget', 'pending capture');
                equal(result.state.event.kind, 'pending-interrupt', 'frozen source');
                equal(result.state.interrupts.nmiBlocked, true, 'blocking before attempt');
              }
              if (row.kind === 'irq-private-idt-repair' || row.kind === 'iret-private-unblock') {
                result = await call(1n, 1n);
                equal(
                  result.reason,
                  row.kind === 'irq-private-idt-repair' ? 'system-memory-fault' : 'data-fault',
                  'private refusal',
                );
                if (row.kind === 'irq-private-idt-repair') {
                  equal(result.state.event.kind, 'pending-interrupt', 'accepted source retained');
                  cpu.setMappings(mappings(row));
                } else equal(result.state.interrupts.nmiBlocked, false, 'IRET early unblock');
              }
              const completeCycle = row.kind === 'irq-iret' || row.kind === 'nmi-iret';
              result = await call(
                row.kind === 'sti-hlt-irq' || row.kind === 'executable-frame-alias' ? 2n : 1n,
                1n,
                completeCycle ? undefined : HANDLER,
              );
              accepted++;
              equal(
                result.reason,
                completeCycle || row.kind === 'sti-hlt-irq' ? 'budget' : 'stop',
                'entry/cycle completion',
              );
              const returnPc =
                CODE +
                (row.kind === 'sti-hlt-irq'
                  ? 2n
                  : row.kind === 'halted-nmi-wakeup' || row.kind === 'executable-frame-alias'
                    ? 1n
                    : 0n);
              const savedFlags = row.kind === 'sti-hlt-irq' ? 0x202n : initial.flags;
              put(bytes, STACK - 12n, returnPc);
              put(bytes, STACK - 8n, 8n);
              put(bytes, STACK - 4n, savedFlags);
              if (row.kind === 'rep-idle-reentry') bytes[0x2100] = 0x11;
              equal(result.state.rip, completeCycle ? CODE : HANDLER, 'logical continuation');
              equal(result.state.registers[4], completeCycle ? STACK : STACK - 12n, 'frame stack');
              equal(result.state.event, { kind: 'ready' }, 'no accepted source replay');
              equal(
                result.state.interrupts,
                { ...EMPTY, nmiBlocked: isNmi(row) && !completeCycle },
                'post-entry source lifetime',
              );
              const expected = structuredClone(initial);
              expected.rip = completeCycle ? CODE : HANDLER;
              expected.registers[4] = completeCycle ? STACK : STACK - 12n;
              expected.flags = completeCycle ? initial.flags : 2n;
              expected.interruptibility = { sti: false, ss: false };
              expected.event = { kind: 'ready' };
              expected.interrupts = { ...EMPTY, nmiBlocked: isNmi(row) && !completeCycle };
              if (row.kind === 'rep-idle-reentry') {
                expected.registers[1] = 1n;
                expected.registers[6]++;
                expected.registers[7]++;
              }
              equal(result.state, expected, 'complete event continuation state');
              guardFaults(result);
            }
            equal(accepted, n, 'accepted source count');
            equal(
              attempts,
              n * (row.kind === 'irq-private-idt-repair' ? 2n : 1n),
              'attempt count includes private refusals',
            );
            equal(
              retired,
              (row.kind === 'sti-hlt-irq'
                ? 2n
                : row.kind === 'irq-iret' ||
                    row.kind === 'nmi-iret' ||
                    row.kind === 'executable-frame-alias'
                  ? 1n
                  : 0n) * n,
              'guest retirements',
            );
          }
          const wallMs = performance.now() - began;
          equal(repeated, 0n, 'measured entry/cycle calls execute no REP element');
          if (row.kind !== 'iret-private-unblock')
            equal(
              Array.from(cpu.readMemory(RAM, RAM_BYTES)),
              Array.from(bytes),
              'complete RAM/frame guards',
            );
          else {
            equal(
              Array.from(cpu.readMemory(RAM, 0x4000)),
              Array.from(bytes.subarray(0, 0x4000)),
              'IRET refusal complete readable RAM prefix',
            );
            equal(
              Array.from(cpu.readMemory(STACK + 12n, RAM_BYTES - 0x400c)),
              Array.from(bytes.subarray(0x400c)),
              'IRET refusal complete readable RAM suffix',
            );
          }
          const expectedCode = code.slice();
          if (row.kind === 'executable-frame-alias')
            expectedCode.set(bytes.subarray(0x3ff4, 0x4000));
          equal(
            Array.from(cpu.readMemory(CODE, code.length)),
            Array.from(expectedCode),
            'complete source/handler code',
          );
          equal(cpu.readContext(), expectedContext, 'complete context');
          equal(cpu.readXmmState(), numeric.xmm, 'XMM');
          equal(cpu.readMxcsr(), numeric.mxcsr, 'MXCSR');
          equal(cpu.readX87State(), numeric.x87, 'x87');
          const units = cpu.inspectTranslations();
          equal(result.resources.cachedArtifacts, units.length, 'artifact ownership');
          equal(
            result.resources.cachedBytes,
            units.reduce((total, unit) => total + unit.byteLength, 0),
            'artifact bytes',
          );
          if (row.control && units.some((unit) => unit.boundaryObserved))
            throw Error('inhibited queue created unnecessary observer');
          results.push({
            side: side.label,
            workload: row.name,
            sample,
            window: sample === 0 ? 'first' : sample < 4 ? 'early' : 'later',
            elapsedMs,
            wallMs,
            calls,
            queueRequests: row.control ? BigInt(row.queued) : n,
            accepted,
            deliveryAttempts: attempts,
            retired,
            repeatIterations: repeated,
            excludedPreparation: {
              retired: setupRetired,
              repeatIterations: setupRepeated,
              resources: setupResources,
              timings: setupTimings,
            },
            resources: { ...result.resources, ...resources },
            timings,
            state: result.state,
            units,
            context: cpu.readContext(),
          });
        }
    } finally {
      for (const { cpu } of active) cpu.dispose();
    }
  }
  return { definitions, samples: results, unavailable };
}
