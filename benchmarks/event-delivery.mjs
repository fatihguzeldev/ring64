const CODE = 0x1000n;
const HANDLER = CODE + 32n;
const RAM = 0x4000n;
const STACK = RAM + 128n;
const GDT = RAM + 256n;
const IDT = RAM + 768n;
const DATA = RAM + 1536n;
const RAM_BYTES = 4096;
const LIMITS = {
  maxInstructions: 128,
  maxSourceBytes: 2048,
  maxArtifactBytes: 262144,
  maxCachedArtifacts: 32,
  maxCachedBytes: 4194304,
  maxTranslationsPerRun: 32,
};
const hex = (source) => Uint8Array.from(source.match(/../g) ?? [], (v) => parseInt(v, 16));
const image = (value) =>
  JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? item.toString() : item));
function equal(actual, expected, label) {
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length) throw Error(`${label}: unequal lengths`);
    for (let i = 0; i < actual.length; i++)
      if (actual[i] !== expected[i])
        throw Error(`${label}[${i}]: ${String(actual[i])} != ${String(expected[i])}`);
    return;
  }
  if (image(actual) !== image(expected))
    throw Error(`${label}: ${image(actual)} != ${image(expected)}`);
}
function put(bytes, address, value, width = 4) {
  const start = Number(address - RAM);
  for (let i = 0; i < width; i++) bytes[start + i] = Number((value >> BigInt(i * 8)) & 255n);
}
const rows = [
  { name: 'event-de-skip-loop', body: 'f7f7', vector: 0, instructions: 3 },
  { name: 'event-gp-skip-loop', body: '0fae13', vector: 13, instructions: 4, error: true },
  { name: 'event-db-trap-loop', body: '90', vector: 1, instructions: 4, trap: true },
  { name: 'event-mf-pending-loop', body: '9b', vector: 16, instructions: 3 },
  { name: 'event-xm-suppressed-loop', body: 'f30f5ec1', vector: 19, instructions: 3 },
  { name: 'event-de-budget-one-resume', body: 'f7f7', vector: 0, instructions: 3, resume: true },
  {
    name: 'event-db-budget-one-resume',
    body: '90',
    vector: 1,
    instructions: 4,
    trap: true,
    resume: true,
  },
  { name: 'event-de-pending-resume', body: 'f7f7', vector: 0, instructions: 3, pending: true },
  {
    name: 'event-de-code-context-switch',
    body: 'f7f7',
    vector: 0,
    instructions: 3,
    contextSwitch: true,
  },
  { name: 'event-db-executable-frame-alias', body: '90', vector: 1, trap: true, alias: true },
  { name: 'event-db-private-idt-repair', body: '90', vector: 1, trap: true, repair: true },
  { name: 'event-db-partial-rep', body: 'f3a4', vector: 1, trap: true, repeat: true },
  { name: 'event-de-double-fault', body: 'f7f7', vector: 0, escalation: true },
  { name: 'event-de-shutdown', body: 'f7f7', vector: 0, escalation: true, shutdown: true },
];
export const eventDeliveryNames = rows.map((row) => row.name);

function program(row) {
  const code = new Uint8Array(64).fill(0xf4);
  const body = hex(row.body);
  code.set(body);
  if (!row.repeat && !row.escalation && !row.repair && !row.alias)
    code.set([0xe2, -(body.length + 2) & 255], body.length);
  const skip = body.length.toString(16).padStart(2, '0');
  const handler = row.trap ? 'cf' : row.error ? `83442404${skip}83c404cf` : `830424${skip}cf`;
  code.set(hex(handler), 32);
  return code;
}
function memory(row) {
  const bytes = new Uint8Array(RAM_BYTES).fill(0xa5);
  bytes.set([255, 255, 0, 0, 0, 0x9b, 0xcf, 0], 264);
  if (row.contextSwitch) bytes.set([255, 255, 0, 0, 0, 0x9b, 0xcf, 0], 288);
  for (const at of [272, 280]) bytes.set([255, 255, 0, 0, 0, 0x93, 0xcf, 0], at);
  const gate = (vector, valid = true) => {
    const address = IDT + BigInt(vector * 8);
    put(bytes, address, HANDLER & 0xffffn, 2);
    put(bytes, address + 2n, row.contextSwitch ? 32n : 8n, 2);
    put(bytes, address + 4n, 0n, 1);
    put(bytes, address + 5n, valid ? 0x8en : 0n, 1);
    put(bytes, address + 6n, HANDLER >> 16n, 2);
  };
  gate(row.vector, !row.escalation);
  if (row.escalation) gate(8, !row.shutdown);
  put(bytes, DATA, 0x10000n);
  if (row.repeat) for (let i = 0; i < 512; i++) bytes[2048 + i] = (i * 17 + 3) & 255;
  if (row.alias) bytes.set(program(row).subarray(0, 12), 116);
  return bytes;
}
function context(cpu, row) {
  const value = cpu.readContext();
  value.mode = 'protected';
  value.segments.cs.long = false;
  value.segments.cs.default32 = true;
  value.segments.ss.default32 = true;
  value.gdtr = { base: GDT, limit: row.contextSwitch ? 39 : 31 };
  value.idtr = { base: IDT, limit: 19 * 8 + 7 };
  cpu.setContext(value);
  return cpu.readContext();
}
const totals = (keys) => Object.fromEntries(keys.map((key) => [key, 0]));
const resourceKeys = ['compilations', 'cacheHits', 'nativeEntries', 'dispatches', 'generatedBytes'];
const phaseKeys = [
  'translationMs',
  'browserCompileMs',
  'instantiationMs',
  'executionMs',
  'totalMs',
];
function accumulate(target, source) {
  for (const key of Object.keys(target)) target[key] += source[key];
}
function mappings(code, denied = false, aliased = false) {
  const codeMap = {
    base: CODE,
    backing: 'code',
    offset: 0,
    length: code.length,
    permissions: { read: true, write: false, execute: true },
  };
  const part = (offset, length, read = true) => ({
    base: RAM + BigInt(offset),
    backing: 'ram',
    offset,
    length,
    permissions: { read, write: true, execute: false },
  });
  if (aliased)
    return [
      codeMap,
      part(0, 116),
      { ...part(116, 12), backing: 'code', offset: 0 },
      part(128, RAM_BYTES - 128),
    ];
  return denied
    ? [codeMap, part(0, 776), part(776, 8, false), part(784, RAM_BYTES - 784)]
    : [codeMap, part(0, RAM_BYTES)];
}
function numeric(cpu, row) {
  const xmm = Array.from({ length: 16 }, (_, i) => (BigInt(i + 1) << 96n) | BigInt(i));
  xmm[0] = 0x112233445566778899aabbcc3f800000n;
  xmm[1] = 0n;
  cpu.setXmmState(xmm);
  const mxcsr = row.vector === 19 ? 0x1d80 : 0x1f80;
  cpu.setMxcsr(mxcsr);
  const x87 = cpu.readX87State();
  x87.controlWord = row.vector === 16 ? 0x37e : 0x37f;
  x87.statusWord = row.vector === 16 ? 0x8081 : 0;
  x87.tagWord = 0xffff;
  x87.instructionPointer = 0x5555n;
  x87.dataPointer = 0x6666n;
  x87.opcode = 0x123;
  cpu.setX87State(x87);
  return { xmm, mxcsr, x87 };
}
function initial(row, n) {
  const registers = Array.from({ length: 16 }, (_, i) => 0x1122334400000000n + BigInt(i));
  registers[0] = 6n;
  registers[1] = n;
  registers[2] = 0n;
  registers[3] = DATA;
  registers[4] = STACK;
  registers[7] = 0n;
  if (row.repeat) {
    registers[6] = RAM + 2048n;
    registers[7] = RAM + 3072n;
  }
  return { registers, flags: row.trap ? 0x302n : 0x202n, rip: CODE };
}
function noFault(result) {
  for (const field of [
    'fault',
    'segmentFault',
    'alignmentFault',
    'simdException',
    'generalProtectionFault',
    'x87Exception',
    'protectionFault',
    'systemMemoryFault',
    'debugException',
  ])
    equal(result[field], undefined, field);
}

export async function measureEventDelivery(
  sides,
  { iterations, samples, workloads, reverse = false },
) {
  const definitions = [],
    results = [],
    unavailable = [];
  for (const row of rows.filter((row) => workloads.includes(row.name))) {
    const n = BigInt(
      Math.min(
        iterations,
        row.repeat
          ? 512
          : row.resume ||
              row.pending ||
              row.repair ||
              row.alias ||
              row.contextSwitch ||
              row.escalation
            ? 1001
            : 10001,
      ),
    );
    const code = program(row);
    const kernelLimits = row.contextSwitch
      ? { ...LIMITS, maxTranslationsPerRun: 4 * Number(n) + 4 }
      : LIMITS;
    const retired = row.repeat
      ? n + 1n
      : row.repair || row.alias
        ? n
        : row.escalation
          ? 0n
          : BigInt(row.instructions) * n;
    const attempts =
      (row.alias ? 1n : row.escalation || row.repair || (row.trap && !row.repeat) ? 2n : 1n) * n;
    definitions.push({
      name: row.name,
      limits: kernelLimits,
      profile: 'protected32',
      code: Array.from(code, (b) => b.toString(16).padStart(2, '0')).join(''),
      handler: HANDLER,
      iterations: n,
      instructions: retired,
      deliveryAttempts: attempts,
      repeatBudget: row.repeat ? n : 0n,
      work: attempts,
      throughputUnit: 'automatic entry attempts',
      timing: {
        elapsedMs: 'sum of awaited run calls, excludes host reset/repair and output guards',
        wallMs: 'includes per-call resets, mapping repair and inter-call checks',
      },
      resume: !!row.resume,
      pendingResume: !!row.pending,
      privateRepair: !!row.repair,
      contextChanging: !!row.contextSwitch,
      executableFrameAlias: !!row.alias,
      resetBetweenCalls: !!row.escalation || !!row.repair || !!row.alias,
      ceiling: row.escalation
        ? 'DF/shutdown are inspectable terminal cases; no abort recovery claim.'
        : 'Checked private-memory exception execution, not application throughput.',
    });
    const active = [];
    try {
      for (const side of sides) {
        if (
          !WebAssembly.Module.exports(side.compiler).some(
            (entry) => entry.name === 'core_stage_exception',
          )
        ) {
          if (side.label === 'current')
            throw Error('current build is missing automatic exception delivery');
          unavailable.push({
            side: side.label,
            workload: row.name,
            reason:
              'automatic exception delivery unavailable; report-only execution is not an equivalent baseline',
          });
          continue;
        }
        const cpu = await side.createCpu({
          compiler: side.compiler,
          entry: CODE,
          memory: {
            backings: [
              { id: 'code', bytes: code },
              { id: 'ram', bytes: memory(row) },
            ],
            mappings: mappings(code, false, row.alias),
          },
          memoryLimits: {
            maxBackings: 2,
            maxBackingBytes: RAM_BYTES + code.length,
            maxMappings: 4,
          },
          limits: kernelLimits,
        });
        const entry = { side, cpu };
        active.push(entry);
        entry.expectedContext = context(cpu, row);
      }
      for (let sample = 0; sample < samples; sample++)
        for (const { side, cpu, expectedContext } of (sample + Number(reverse)) % 2
          ? [...active].reverse()
          : active) {
          const input = initial(row, n);
          const bytes = memory(row);
          cpu.writeMemory(RAM, bytes);
          const expectedNumeric = numeric(cpu, row);
          cpu.setState(input);
          const resources = totals(resourceKeys),
            timings = totals(phaseKeys);
          let elapsedMs = 0,
            calls = 0,
            totalRetired = 0n,
            totalAttempts = 0n,
            totalRepeated = 0n,
            result;
          const call = async (budget, deliveryBudget, stop) => {
            const at = performance.now();
            const output = await cpu.run({
              budget,
              repeatBudget: row.repeat ? n : 0n,
              exceptionDelivery: { budget: deliveryBudget },
              ...(stop === undefined ? {} : { stop }),
            });
            elapsedMs += performance.now() - at;
            calls++;
            totalRetired += output.retired;
            totalAttempts += output.deliveryAttempts;
            totalRepeated += output.repeatIterations;
            equal(
              output.deliveryAttempts + output.remainingDeliveryBudget,
              deliveryBudget,
              'delivery accounting',
            );
            accumulate(resources, output.resources);
            accumulate(timings, output.timings);
            return output;
          };
          const began = performance.now();
          if (row.escalation || row.repair || row.alias) {
            for (let i = 0n; i < n; i++) {
              cpu.setState(input);
              if (row.repair) cpu.setMappings(mappings(code, true));
              if (row.alias) cpu.writeMemory(STACK - 12n, code.subarray(0, 12));
              result = await call(row.alias ? 2n : 1n, row.repair || row.alias ? 1n : 3n, HANDLER);
              if (row.repair) {
                equal(result.reason, 'system-memory-fault', 'private IDT refusal');
                equal(result.systemMemoryFault?.instructionPc, CODE, 'completed trap source');
                equal(result.systemMemoryFault?.table, 'idt', 'private table');
                equal(result.systemMemoryFault?.vector, 1, 'private vector');
                equal(result.systemMemoryFault?.address, IDT + 8n, 'private gate address');
                equal(result.systemMemoryFault?.width, 8, 'complete gate span');
                equal(result.systemMemoryFault?.phase, 'gate-read', 'private phase');
                equal(result.systemMemoryFault?.cause, 'permission', 'private refusal cause');
                equal(result.state.rip, CODE + 1n, 'completed trap continuation');
                equal(result.state.event.kind, 'pending', 'retained trap');
                if (i === 0n)
                  equal(
                    Array.from(cpu.readMemory(STACK - 16n, 16)),
                    Array(16).fill(0xa5),
                    'refused entry publishes no frame',
                  );
                cpu.setMappings(mappings(code));
                result = await call(1n, 1n, HANDLER);
              }
              equal(result.reason, row.shutdown ? 'shutdown' : 'stop', 'terminal entry result');
            }
          } else if (row.pending) {
            for (let i = 0n; i < n; i++) {
              result = await call(3n, 0n);
              equal(result.reason, 'event-budget', 'pending suspension');
              equal(result.retired, 0n, 'source has not retired');
              equal(result.state.event.kind, 'pending', 'pending source');
              result = await call(3n, 1n);
              equal(result.reason, 'budget', 'pending resume completes one cycle');
            }
          } else if (row.resume) {
            for (let i = 0n; i < retired; i++) {
              result = await call(1n, 1n);
              equal(result.reason, 'budget', 'budget-one resume');
              equal(result.retired, 1n, 'budget-one retirement');
            }
          } else result = await call(retired, attempts);
          const wallMs = performance.now() - began;
          equal(totalRetired, retired, 'total guest retirements');
          equal(totalAttempts, attempts, 'total entry attempts');
          equal(totalRepeated, row.repeat ? n : 0n, 'completed repeat elements');
          const expected = structuredClone(input);
          const end =
            CODE +
            BigInt(
              row.body.length / 2 +
                (row.repeat || row.escalation || row.repair || row.alias ? 0 : 2),
            );
          expected.rip = row.shutdown
            ? CODE
            : row.repair || row.escalation || row.alias
              ? HANDLER
              : end;
          if (!row.repair && !row.escalation && !row.alias) expected.registers[1] = 0n;
          if (row.repeat) {
            expected.registers[6] += n;
            expected.registers[7] += n;
          }
          expected.flags = row.shutdown
            ? 0x202n
            : row.repair || row.escalation || row.alias
              ? 2n
              : input.flags;
          expected.interruptibility = { sti: false, ss: false };
          expected.event = { kind: row.shutdown ? 'shutdown' : 'ready' };
          if (!row.shutdown) {
            const framePc = row.escalation
              ? CODE
              : row.repair || row.alias
                ? CODE + 1n
                : row.trap
                  ? end
                  : CODE + BigInt(row.body.length / 2);
            const savedFlags = row.trap ? 0x302n : 0x10202n;
            put(bytes, STACK - 4n, savedFlags);
            put(bytes, STACK - 8n, 8n);
            put(bytes, STACK - 12n, framePc);
            if (row.error || row.escalation) put(bytes, STACK - 16n, 0n);
            if (row.repair || row.escalation || row.alias)
              expected.registers[4] -= row.escalation ? 16n : 12n;
          }
          if (row.repeat) bytes.copyWithin(3072, 2048, 2048 + Number(n));
          equal(result.state, expected, 'complete scalar/event state');
          equal(cpu.readContext(), expectedContext, 'complete context');
          equal(cpu.readXmmState(), expectedNumeric.xmm, 'complete XMM state');
          equal(
            cpu.readMxcsr(),
            row.vector === 19 ? 0x1d84 : expectedNumeric.mxcsr,
            'MXCSR status',
          );
          equal(cpu.readX87State(), expectedNumeric.x87, 'complete raw x87 state');
          equal(
            Array.from(cpu.readMemory(RAM, RAM_BYTES)),
            Array.from(bytes),
            'guarded RAM and frames',
          );
          const expectedCode = code.slice();
          if (row.alias) expectedCode.set(bytes.subarray(116, 128));
          equal(
            Array.from(cpu.readMemory(CODE, code.length)),
            Array.from(expectedCode),
            'backing-aware code bytes',
          );
          noFault(result);
          const units = cpu.inspectTranslations();
          equal(result.resources.cachedArtifacts, units.length, 'retained artifact accounting');
          equal(
            result.resources.cachedBytes,
            units.reduce((size, unit) => size + unit.byteLength, 0),
            'cached bytes',
          );
          if (units.length > 4) throw Error('event kernel retained unexpected translation owners');
          if (row.alias) equal(units.length, 0, 'frame alias invalidates the active source');
          if (row.contextSwitch && resources.compilations < 2 * Number(n))
            throw Error('context changes must invalidate source and handler assumptions');
          if (!row.repair && !row.alias && !row.contextSwitch && sample > 0)
            equal(resources.compilations, 0, 'stable sample reuses translations');
          results.push({
            side: side.label,
            workload: row.name,
            sample,
            window: sample === 0 ? 'first' : sample < 4 ? 'early' : 'later',
            elapsedMs,
            wallMs,
            calls,
            deliveryAttempts: totalAttempts,
            retired: totalRetired,
            repeatIterations: totalRepeated,
            timing: 'elapsedMs excludes host reset/repair/output guards; wallMs includes them',
            creationMs: cpu.creationMs,
            resources: { ...result.resources, ...resources },
            timings,
            state: result.state,
            context: cpu.readContext(),
            xmm: cpu.readXmmState(),
            mxcsr: cpu.readMxcsr(),
            x87: cpu.readX87State(),
            units,
          });
        }
    } finally {
      for (const { cpu } of active) cpu.dispose();
    }
  }
  return { definitions, samples: results, unavailable };
}
