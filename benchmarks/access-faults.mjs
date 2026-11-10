const CODE = 0x1000n;
const HANDLER = CODE + 64n;
const RAM = 0x4000n;
const RAM_BYTES = 0x5000;
const GDT = 0x4100n;
const TSS = 0x4200n;
const IDT = 0x4300n;
const DATA = 0x5000n;
const SOURCE = 0x6000n;
const DESTINATION = 0x6100n;
const STACK = 0x8000n;
const ALIAS = 0x9000n;
const NONCANONICAL = 0x0000800000000000n;
const EMPTY = { irq: null, nmiPending: false, nmiBlocked: false };
const LIMITS = {
  maxInstructions: 128,
  maxSourceBytes: 2048,
  maxArtifactBytes: 262144,
  maxCachedArtifacts: 32,
  maxCachedBytes: 4194304,
  maxTranslationsPerRun: 32,
};
const hex = (value) => Uint8Array.from(value.match(/../g) ?? [], (v) => parseInt(v, 16));
const little = (value, width) =>
  Array.from({ length: width }, (_, i) => Number((value >> BigInt(i * 8)) & 255n));
const encoded = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const integer = (value, width) => encoded(little(value, width));
const stable = (value) =>
  JSON.stringify(value, (_, item) => {
    if (typeof item === 'bigint') return item.toString();
    if (item !== null && typeof item === 'object' && !Array.isArray(item))
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
    return item;
  });
function equal(actual, expected, label) {
  if (stable(actual) !== stable(expected))
    throw Error(`${label}: ${stable(actual)} != ${stable(expected)}`);
}
function put(bytes, address, value, width) {
  bytes.set(little(value, width), Number(address - RAM));
}
const rows = [
  { name: 'access-gp-noncanonical-repair-loop', kind: 'scalar', loop: true, vector: 13 },
  { name: 'access-gp-alignment-repair-loop', kind: 'alignment', loop: true, vector: 13 },
  { name: 'access-ss-ist-repair-loop', kind: 'stack', loop: true, vector: 12 },
  { name: 'access-ud-guest-alias-repair', kind: 'undefined', vector: 6, alias: true },
  { name: 'access-length-guest-alias-repair', kind: 'length', vector: 13, alias: true },
  { name: 'access-rep-segment-repair', kind: 'repeat', vector: 13, repeat: true },
  { name: 'access-repe-segment-repair', kind: 'compare', vector: 13, repeat: true },
  { name: 'access-gp-private-idt-repair', kind: 'private', vector: 13 },
  { name: 'access-gp-entry-double-fault', kind: 'double-fault', vector: 13 },
  { name: 'access-gp-entry-shutdown', kind: 'shutdown', vector: 13 },
];
export const accessFaultNames = rows.map((row) => row.name);

function program(row) {
  const bytes = new Uint8Array(128).fill(0x82);
  const body = row.kind === 'alignment' ? '0f2803' : row.kind === 'stack' ? '488b0424' : '488b03';
  if (row.loop) {
    const prefix =
      (row.kind === 'stack' ? '48bc' : '48bb') +
      integer(row.kind === 'alignment' ? DATA + 1n : NONCANONICAL, 8);
    const length = prefix.length / 2 + body.length / 2 + 2;
    bytes.set(hex(prefix + body + 'e2' + integer(BigInt(-length & 255), 1)));
  } else
    bytes.set(
      row.kind === 'undefined'
        ? hex('f090')
        : row.kind === 'length'
          ? hex('66'.repeat(15) + '90')
          : row.repeat
            ? hex(row.kind === 'compare' ? 'f3a6' : 'f3a4')
            : hex(body),
    );
  const patch = 'c605' + integer(ALIAS - (HANDLER + 7n), 4) + '90';
  const handler = row.alias
    ? patch + (row.kind === 'length' ? '4883c408' : '') + '48cf'
    : row.repeat
      ? '66b818008ed883c404cf'
      : row.kind === 'stack'
        ? '48c7442420' + integer(DATA, 4) + '4883c40848cf'
        : '48bb' + integer(DATA, 8) + '4883c40848cf';
  bytes.set(hex(handler), 64);
  return bytes;
}
function descriptor(base = 0n) {
  return [255, 255, ...little(base, 3), 0x93, 0xcf, Number(base >> 24n) & 255];
}
function memory(row) {
  const bytes = new Uint8Array(RAM_BYTES).fill(0xa5);
  const code = [255, 255, 0, 0, 0, 0x9b, row.repeat ? 0xcf : 0xaf, 0];
  bytes.set([...code, ...descriptor(), ...descriptor(SOURCE)], Number(GDT + 8n - RAM));
  for (const vector of [row.vector, 8]) {
    const at = IDT + BigInt(vector * (row.repeat ? 8 : 16));
    const absent =
      ((row.kind === 'double-fault' || row.kind === 'shutdown') && vector === 13) ||
      (row.kind === 'shutdown' && vector === 8);
    put(bytes, at, HANDLER & 0xffffn, 2);
    put(bytes, at + 2n, 8n, 2);
    put(bytes, at + 4n, row.kind === 'stack' ? 1n : 0n, 1);
    put(bytes, at + 5n, absent ? 0x0en : 0x8en, 1);
    put(bytes, at + 6n, 0n, 2);
    if (!row.repeat) {
      put(bytes, at + 8n, 0n, 4);
      put(bytes, at + 12n, 0n, 4);
    }
  }
  put(bytes, TSS + 36n, STACK, 8);
  put(bytes, DATA, 0x1122334455667788n, 8);
  put(bytes, DATA + 8n, 0x99aabbccddeeff00n, 8);
  bytes.set([0x11, 0x22, 0x33, 0x44], Number(SOURCE - RAM));
  if (row.kind === 'compare') bytes.set([0x11, 0x22, 0x33, 0x44], Number(DESTINATION - RAM));
  return bytes;
}
function mappings(row, denied = false) {
  const code = {
    base: CODE,
    backing: 'code',
    offset: 0,
    length: 128,
    permissions: { read: true, write: false, execute: true },
  };
  const part = (offset, length, read = true) => ({
    base: RAM + BigInt(offset),
    backing: 'ram',
    offset,
    length,
    permissions: { read, write: true, execute: false },
  });
  const offset = Number(IDT + BigInt(13 * 16) - RAM);
  return [
    code,
    ...(denied
      ? [part(0, offset), part(offset, 16, false), part(offset + 16, RAM_BYTES - offset - 16)]
      : [part(0, RAM_BYTES)]),
    ...(row.alias
      ? [
          {
            base: ALIAS,
            backing: 'code',
            offset: 0,
            length: 1,
            permissions: { read: false, write: true, execute: false },
          },
        ]
      : []),
  ];
}
function context(cpu, row) {
  const value = cpu.readContext();
  if (row.repeat) {
    value.mode = 'protected';
    value.segments.cs.long = false;
    value.segments.cs.default32 = true;
    value.segments.ss.default32 = true;
    value.segments.ds.base = SOURCE;
    value.segments.ds.limit = 1;
    value.segments.ds.selector = 24;
    value.segments.ds.granularity = false;
  }
  value.gdtr = { base: GDT, limit: 31 };
  value.idtr = { base: IDT, limit: 0xfff };
  if (row.kind === 'stack')
    value.tr = { selector: 0x28, valid: true, base: TSS, limit: 0x67, attributes: 0x8b };
  cpu.setContext(value);
  return cpu.readContext();
}
function numeric(cpu) {
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
  return { xmm: cpu.readXmmState(), mxcsr: cpu.readMxcsr(), x87: cpu.readX87State() };
}
function initial(row, n) {
  const registers = Array.from({ length: 16 }, (_, i) => 0x1122334400000000n + BigInt(i));
  registers[1] = row.loop ? n : row.repeat ? 4n : 3n;
  registers[3] = NONCANONICAL;
  registers[4] = STACK;
  registers[6] = 0n;
  registers[7] = DESTINATION;
  return {
    registers,
    flags: 0x202n,
    rip: CODE,
    interruptibility: { sti: false, ss: false },
    event: { kind: 'ready' },
    interrupts: { ...EMPTY },
  };
}
const resourceKeys = ['compilations', 'cacheHits', 'nativeEntries', 'dispatches', 'generatedBytes'];
const phaseKeys = [
  'translationMs',
  'browserCompileMs',
  'instantiationMs',
  'executionMs',
  'totalMs',
];
const totals = (fields) => Object.fromEntries(fields.map((key) => [key, 0]));
const sum = (target, source) => {
  for (const key of Object.keys(target)) target[key] += source[key];
};
function noFault(result) {
  for (const name of [
    'fault',
    'segmentFault',
    'alignmentFault',
    'simdException',
    'x87Exception',
    'generalProtectionFault',
    'protectionFault',
    'systemMemoryFault',
    'debugException',
  ])
    equal(result[name], undefined, `no stale ${name}`);
}
async function supports(s) {
  const cpu = await s.createCpu({
    compiler: s.compiler,
    code: { base: CODE, bytes: hex('f090') },
    ram: { base: RAM, bytes: new Uint8Array(64) },
    limits: LIMITS,
  });
  try {
    const r = await cpu.run({ budget: 1n, exceptionDelivery: { budget: 0n } });
    return (
      r.reason === 'event-budget' &&
      r.state.event.kind === 'pending' &&
      r.state.event.exception.vector === 6
    );
  } finally {
    cpu.dispose();
  }
}

export async function measureAccessFaults(
  sides,
  { iterations, samples, workloads, reverse = false },
) {
  const selected = rows.filter((row) => workloads.includes(row.name));
  if (!selected.length) return { definitions: [], samples: [], unavailable: [] };
  const capable = new Map();
  for (const side of sides) {
    const supported = await supports(side);
    if (!supported && side.label === 'current')
      throw Error('current build is missing selected access/legality delivery');
    capable.set(side.label, supported);
  }
  const definitions = [],
    results = [],
    unavailable = [];
  for (const row of selected) {
    const n = BigInt(
      Math.min(
        iterations,
        row.kind === 'stack' || row.repeat || row.alias ? 501 : row.loop ? 10001 : 1001,
      ),
    );
    const code = program(row),
      bytes = memory(row);
    const limits =
      row.kind === 'stack' ? { ...LIMITS, maxTranslationsPerRun: 5 * Number(n) + 8 } : LIMITS;
    const work =
      row.kind === 'double-fault' || row.kind === 'shutdown' || row.kind === 'private' ? 2n * n : n;
    definitions.push({
      name: row.name,
      profile: row.repeat ? 'protected32' : 'long64',
      code: encoded(code),
      iterations: n,
      work,
      throughputUnit: 'automatic entry attempts',
      sourceFaults: n,
      deliveryAttempts: work,
      limits,
      guestRepair: row.kind !== 'double-fault' && row.kind !== 'shutdown',
      contextChanging: row.kind === 'stack' || row.repeat,
      resetBetweenCalls: !row.loop,
      aliasPatch: !!row.alias,
      repeatElements: row.repeat ? 4n * n : 0n,
      timing: {
        elapsedMs:
          'sum of awaited run calls; excludes host rearming/context reset/private mapping repair and output guards',
        wallMs: 'includes per-call rearming/context reset/repair and intermediate checks',
      },
      ceiling:
        row.kind === 'double-fault' || row.kind === 'shutdown'
          ? 'Inspectable escalation only; no architectural abort recovery claim.'
          : 'Checked selected fault→guest repair→IRET→retry; synthetic private-memory execution, not application throughput.',
    });
    const active = [];
    try {
      for (const side of sides) {
        if (!capable.get(side.label)) {
          unavailable.push({
            side: side.label,
            workload: row.name,
            reason:
              'selected architectural access/legality delivery unavailable; old private reporting is not an equivalent handler/repair baseline',
          });
          continue;
        }
        const cpu = await side.createCpu({
          compiler: side.compiler,
          entry: CODE,
          memory: {
            backings: [
              { id: 'code', bytes: code },
              { id: 'ram', bytes },
            ],
            mappings: mappings(row),
          },
          memoryLimits: { maxBackings: 2, maxBackingBytes: RAM_BYTES + 128, maxMappings: 4 },
          limits,
        });
        active.push({ side, cpu, execution: context(cpu, row) });
      }
      for (let sample = 0; sample < samples; sample++)
        for (const { side, cpu, execution } of (sample + Number(reverse)) % 2
          ? [...active].reverse()
          : active) {
          const state = initial(row, n),
            expected = structuredClone(state),
            expectedBytes = bytes.slice(),
            expectedCode = code.slice(),
            expectedNumeric = numeric(cpu);
          cpu.writeMemory(RAM, bytes);
          cpu.setState(state);
          const resources = totals(resourceKeys),
            timings = totals(phaseKeys);
          let result,
            elapsedMs = 0,
            calls = 0,
            retired = 0n,
            attempts = 0n,
            repeated = 0n;
          const call = async (budget, allowance, stop) => {
            const at = performance.now();
            const r = await cpu.run({
              budget,
              repeatBudget: row.repeat ? 4n : 0n,
              exceptionDelivery: { budget: allowance },
              ...(stop === undefined ? {} : { stop }),
            });
            elapsedMs += performance.now() - at;
            calls++;
            retired += r.retired;
            attempts += r.deliveryAttempts;
            repeated += r.repeatIterations;
            equal(r.deliveryAttempts + r.remainingDeliveryBudget, allowance, 'entry accounting');
            sum(resources, r.resources);
            sum(timings, r.timings);
            return r;
          };
          const began = performance.now();
          if (row.loop) result = await call(6n * n, n);
          else
            for (let cycle = 0n; cycle < n; cycle++) {
              if (row.repeat) cpu.setContext(execution);
              cpu.setState(state);
              if (row.alias) cpu.writeMemory(ALIAS, code.subarray(0, 1));
              if (row.kind === 'repeat')
                cpu.writeMemory(
                  DESTINATION,
                  bytes.subarray(Number(DESTINATION - RAM), Number(DESTINATION - RAM) + 4),
                );
              if (row.kind === 'private') {
                const frameBefore = cpu.readMemory(STACK - 48n, 48);
                cpu.setMappings(mappings(row, true));
                result = await call(4n, 1n);
                equal(result.reason, 'system-memory-fault', 'private gate refusal');
                for (const [name, value] of Object.entries({
                  instructionPc: CODE,
                  table: 'idt',
                  vector: 13,
                  address: IDT + 13n * 16n,
                  width: 16,
                  phase: 'gate-read',
                  cause: 'permission',
                }))
                  equal(result.systemMemoryFault?.[name], value, `private gate ${name}`);
                equal(result.retired, 0n, 'fault source has not retired');
                equal(
                  result.state,
                  {
                    ...state,
                    event: {
                      kind: 'pending',
                      exception: {
                        vector: 13,
                        instructionPc: CODE,
                        returnPc: CODE,
                        savedFlags: 0x10202n,
                        errorCode: 0,
                      },
                    },
                  },
                  'complete checkpoint retained through private refusal',
                );
                equal(cpu.readContext(), execution, 'private refusal leaves context intact');
                equal(
                  Array.from(cpu.readMemory(STACK - 48n, 48)),
                  Array.from(frameBefore),
                  'no half entry before repair',
                );
                cpu.setMappings(mappings(row));
              }
              result = await call(
                row.alias
                  ? row.kind === 'undefined'
                    ? 4n
                    : 5n
                  : row.repeat
                    ? 5n
                    : row.kind === 'private'
                      ? 4n
                      : 1n,
                row.kind === 'double-fault' || row.kind === 'shutdown' ? 2n : 1n,
                row.kind === 'double-fault' ? HANDLER : undefined,
              );
              equal(
                result.reason,
                row.kind === 'double-fault'
                  ? 'stop'
                  : row.kind === 'shutdown'
                    ? 'shutdown'
                    : 'budget',
                'completed fault cycle',
              );
              noFault(result);
            }
          const wallMs = performance.now() - began;
          const shutdown = row.kind === 'shutdown',
            aborted = row.kind === 'double-fault';
          expected.rip = shutdown
            ? CODE
            : aborted
              ? HANDLER
              : row.loop
                ? CODE + (row.kind === 'stack' ? 16n : 15n)
                : row.alias
                  ? CODE + (row.kind === 'undefined' ? 2n : 16n)
                  : CODE + (row.repeat ? 2n : 3n);
          expected.event = { kind: shutdown ? 'shutdown' : 'ready' };
          expected.flags = aborted ? 2n : row.kind === 'compare' ? 0x246n : state.flags;
          if (row.loop) expected.registers[1] = 0n;
          if (row.kind === 'scalar' || row.kind === 'stack' || row.kind === 'private')
            expected.registers[0] = 0x1122334455667788n;
          if (row.kind === 'scalar' || row.kind === 'alignment' || row.kind === 'private')
            expected.registers[3] = DATA;
          if (row.kind === 'alignment')
            expectedNumeric.xmm[0] = 0x99aabbccddeeff001122334455667788n;
          if (row.kind === 'stack') expected.registers[4] = DATA;
          if (row.repeat) {
            expected.registers[0] = (state.registers[0] & ~0xffffn) | 24n;
            expected.registers[1] = 0n;
            expected.registers[6] = 4n;
            expected.registers[7] = DESTINATION + 4n;
          }
          if (aborted) expected.registers[4] = STACK - 48n;
          if (!shutdown) {
            const pc = row.loop ? CODE + 10n : CODE;
            const width = row.repeat ? 4 : 8;
            const frame = row.repeat
              ? [0n, pc, 8n, 0x10202n]
              : row.kind === 'undefined'
                ? [pc, 8n, 0x10202n, STACK, 16n]
                : [0n, pc, 8n, 0x10202n, row.kind === 'stack' ? DATA : STACK, 16n];
            let at = STACK - BigInt(width * frame.length);
            for (const value of frame) {
              put(expectedBytes, at, value, width);
              at += BigInt(width);
            }
          }
          if (row.kind === 'repeat')
            expectedBytes.set(
              bytes.subarray(Number(SOURCE - RAM), Number(SOURCE - RAM) + 4),
              Number(DESTINATION - RAM),
            );
          if (row.alias) expectedCode[0] = 0x90;
          const expectedExecution = structuredClone(execution);
          if (row.repeat) {
            expectedExecution.segments.ds.limit = 0xffffffff;
            expectedExecution.segments.ds.granularity = true;
          }
          equal(result.reason, aborted ? 'stop' : shutdown ? 'shutdown' : 'budget', 'final reason');
          equal(result.state, expected, 'complete scalar/event/interrupt state');
          equal(attempts, work, 'total attempts including private refusal/escalation');
          equal(
            retired,
            row.loop
              ? 6n * n
              : row.alias
                ? (row.kind === 'undefined' ? 4n : 5n) * n
                : row.repeat
                  ? 5n * n
                  : row.kind === 'private'
                    ? 4n * n
                    : 0n,
            'total retirement',
          );
          equal(repeated, row.repeat ? 4n * n : 0n, 'committed repeated work');
          equal(cpu.readContext(), expectedExecution, 'complete post-repair context');
          equal(cpu.readXmmState(), expectedNumeric.xmm, 'complete XMM banks');
          equal(cpu.readMxcsr(), expectedNumeric.mxcsr, 'MXCSR');
          equal(cpu.readX87State(), expectedNumeric.x87, 'complete raw x87 state');
          equal(
            Array.from(cpu.readMemory(RAM, RAM_BYTES)),
            Array.from(expectedBytes),
            'all RAM/frame guards',
          );
          equal(
            Array.from(cpu.readMemory(CODE, 128)),
            Array.from(expectedCode),
            'guest code and alias patch',
          );
          noFault(result);
          const units = cpu.inspectTranslations();
          equal(result.resources.cachedArtifacts, units.length, 'retained artifact count');
          equal(
            result.resources.cachedBytes,
            units.reduce((total, unit) => total + unit.byteLength, 0),
            'retained artifact bytes',
          );
          results.push({
            side: side.label,
            workload: row.name,
            sample,
            window: sample === 0 ? 'first' : sample < 4 ? 'early' : 'later',
            elapsedMs,
            wallMs,
            calls,
            sourceFaults: n,
            deliveryAttempts: attempts,
            retired,
            repeatIterations: repeated,
            resources: { ...result.resources, ...resources },
            timings,
            state: result.state,
            context: cpu.readContext(),
            units,
          });
        }
    } finally {
      for (const { cpu } of active) cpu.dispose();
    }
  }
  return { definitions, samples: results, unavailable };
}
