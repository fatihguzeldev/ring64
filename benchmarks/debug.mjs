const CODE = 0x1000n;
const HANDLER = CODE + 64n;
const SOFTWARE = CODE + 96n;
const RAM = 0x4000n;
const RAM_BYTES = 0x5000;
const GDT = RAM + 0x100n;
const IDT = RAM + 0x300n;
const DATA = 0x5000n;
const SOURCE = 0x6000n;
const DESTINATION = 0x6100n;
const STACK = 0x8000n;
const ALIAS = 0x9000n;
const LIMITS = {
  maxInstructions: 128,
  maxSourceBytes: 2048,
  maxArtifactBytes: 262144,
  maxCachedArtifacts: 32,
  maxCachedBytes: 4194304,
  maxTranslationsPerRun: 32,
};
const hex = (text) => Uint8Array.from(text.match(/../g) ?? [], (x) => parseInt(x, 16));
const little = (value, width) =>
  Array.from({ length: width }, (_, i) => Number((value >> BigInt(8 * i)) & 255n));
const stable = (value) =>
  JSON.stringify(value, (_, v) =>
    typeof v === 'bigint'
      ? v.toString()
      : v !== null && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
        : v,
  );
let checking = '';
function equal(actual, expected, label) {
  if (ArrayBuffer.isView(actual) && ArrayBuffer.isView(expected)) {
    if (actual.length !== expected.length) throw Error(`${checking} ${label}: byte lengths differ`);
    for (let i = 0; i < actual.length; i++)
      if (actual[i] !== expected[i])
        throw Error(`${checking} ${label}: byte ${i}: ${actual[i]} != ${expected[i]}`);
    return;
  }
  if (stable(actual) !== stable(expected))
    throw Error(`${checking} ${label}: ${stable(actual)} != ${stable(expected)}`);
}
function put(bytes, address, value, width = 4) {
  bytes.set(little(value, width), Number(address - RAM));
}
const rows = [
  ...['loop', 'resume'].flatMap((kind) =>
    ['empty', 'execute-miss', 'data-miss', ...(kind === 'loop' ? ['gd-only'] : [])].map((mode) => ({
      name: `debug-${kind}-${mode}`,
      kind,
      mode,
      control: true,
    })),
  ),
  ...[
    'execute-rf-repair',
    'data-write-iret',
    'data-multiple-iret',
    'gd-guest-clear',
    'rep-report',
    'rep-delivery',
    'ss-deferred-halt',
    'ss-rep-private-resume',
    'private-idt-repair',
    'executable-alias-data',
    'ss-software-transition',
  ].map((kind) => ({ name: `debug-${kind}`, kind })),
];
export const debugNames = rows.map((row) => row.name);
const isSs = (row) => row.kind.startsWith('ss-');
const isRep = (row) => row.kind.startsWith('rep-') || row.kind === 'ss-rep-private-resume';
function program(row) {
  const code = new Uint8Array(128).fill(0x82);
  const source = row.control
    ? '8b038903e2fa'
    : row.kind === 'execute-rf-repair'
      ? '90e2fd'
      : row.kind === 'data-write-iret' || row.kind === 'data-multiple-iret'
        ? '8903e2fc'
        : row.kind === 'gd-guest-clear'
          ? '0f21c0'
          : row.kind === 'private-idt-repair'
            ? '90'
            : row.kind === 'executable-alias-data'
              ? '8803'
              : row.kind === 'ss-deferred-halt'
                ? '8e13f4'
                : row.kind === 'ss-software-transition'
                  ? '8e13cd20'
                  : row.kind === 'ss-rep-private-resume'
                    ? '8e13f3a4'
                    : 'f3a4';
  code.set(hex(source));
  code.set(
    hex(
      row.kind === 'execute-rf-repair' || row.kind === 'private-idt-repair'
        ? '814c240800000100cf'
        : row.kind === 'gd-guest-clear'
          ? '0f21f2b8f00fffff0f23f0cf'
          : 'cf',
    ),
    64,
  );
  code[96] = 0xcf;
  return code;
}
function memory(row) {
  const ram = new Uint8Array(RAM_BYTES).fill(0xa5);
  ram.set(hex('ffff0000009bcf00ffff00000093cf00'), Number(GDT + 8n - RAM));
  for (const [vector, handler] of [
    [1, HANDLER],
    [0x20, SOFTWARE],
  ]) {
    const at = IDT + BigInt(vector * 8);
    put(ram, at, handler, 2);
    put(ram, at + 2n, 8n, 2);
    put(ram, at + 4n, 0n, 1);
    put(ram, at + 5n, 0x8en, 1);
    put(ram, at + 6n, 0n, 2);
  }
  put(ram, DATA, isSs(row) ? 16n : 0x11223344n);
  ram.set([0x11, 0x22, 0x33, 0x44], Number(SOURCE - RAM));
  return ram;
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
  const at = Number(IDT + 8n - RAM);
  return [
    code,
    ...(denied
      ? [part(0, at), part(at, 8, false), part(at + 8, RAM_BYTES - at - 8)]
      : [part(0, RAM_BYTES)]),
    ...(row.kind === 'executable-alias-data'
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
function bank(row) {
  let addresses = [0n, 0n, 0n, 0n],
    dr7 = 0x400n;
  if (row.control) {
    if (row.mode === 'execute-miss') {
      addresses[0] = CODE + 32n;
      dr7 = 0x401n;
    }
    if (row.mode === 'data-miss') {
      addresses[0] = DATA + 32n;
      dr7 = 0xd0401n;
    }
    if (row.mode === 'gd-only') dr7 = 0x2400n;
  } else if (row.kind === 'execute-rf-repair' || row.kind === 'private-idt-repair') {
    addresses[0] = CODE;
    dr7 = 0x401n;
  } else if (row.kind === 'data-write-iret') {
    addresses[0] = DATA;
    dr7 = 0xd0401n;
  } else if (row.kind === 'data-multiple-iret') {
    addresses = [DATA, DATA + 2n, 0n, 0n];
    dr7 = 0x5d0405n;
  } else if (row.kind === 'gd-guest-clear') {
    addresses[0] = 0x11223344n;
    dr7 = 0x2400n;
  } else if (row.kind === 'rep-report') {
    addresses[0] = SOURCE + 1n;
    dr7 = 0x30401n;
  } else if (row.kind === 'rep-delivery') {
    addresses[0] = SOURCE;
    dr7 = 0xf0401n;
  } else if (row.kind === 'ss-rep-private-resume') {
    addresses = [DATA, SOURCE, 0n, 0n];
    dr7 = 0xf70405n;
  } else if (row.kind === 'executable-alias-data') {
    addresses[0] = ALIAS;
    dr7 = 0x10401n;
  } else {
    addresses[0] = DATA;
    dr7 = 0x70401n;
  }
  return { addresses, dr6: 0xffff0ff0n, dr7 };
}
function initial(row, n) {
  const registers = Array.from({ length: 16 }, (_, i) => 0x33330000n + BigInt(i));
  registers[0] = row.kind === 'executable-alias-data' ? 0x33330090n : 0x78563412n;
  registers[1] =
    row.control ||
    row.kind === 'execute-rf-repair' ||
    row.kind === 'data-write-iret' ||
    row.kind === 'data-multiple-iret'
      ? n
      : 4n;
  registers[3] = row.kind === 'executable-alias-data' ? ALIAS : DATA;
  registers[4] = STACK;
  registers[6] = SOURCE;
  registers[7] = DESTINATION;
  return {
    registers,
    flags: 0x202n,
    rip: CODE,
    interruptibility: { sti: false, ss: false },
    event: { kind: 'ready' },
    interrupts: { irq: null, nmiPending: false, nmiBlocked: false },
  };
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
const resourceKeys = ['compilations', 'cacheHits', 'nativeEntries', 'dispatches', 'generatedBytes'];
const phaseKeys = [
  'translationMs',
  'browserCompileMs',
  'instantiationMs',
  'executionMs',
  'totalMs',
];
const totals = (keys) => Object.fromEntries(keys.map((key) => [key, 0]));
const sum = (target, source) => {
  for (const key of Object.keys(target)) target[key] += source[key];
};
function noFault(result) {
  for (const key of [
    'fault',
    'segmentFault',
    'alignmentFault',
    'simdException',
    'x87Exception',
    'generalProtectionFault',
    'protectionFault',
    'systemMemoryFault',
  ])
    equal(result[key], undefined, `no stale ${key}`);
}
function frame(ram, sp, words) {
  for (const word of words) {
    put(ram, sp, word);
    sp += 4n;
  }
}
async function capable(side) {
  const cpu = await side.createCpu({
    compiler: side.compiler,
    code: { base: CODE, bytes: hex('90') },
    ram: { base: RAM, bytes: new Uint8Array(64) },
    limits: LIMITS,
  });
  try {
    return typeof cpu.readDebugState === 'function' && typeof cpu.setDebugState === 'function';
  } finally {
    cpu.dispose();
  }
}
export async function measureDebug(sides, { iterations, samples, workloads, reverse = false }) {
  const selected = rows.filter((row) => workloads.includes(row.name));
  if (!selected.length) return { definitions: [], samples: [], unavailable: [] };
  const support = new Map();
  for (const side of sides) {
    const supported = await capable(side);
    if (!supported && side.label === 'current') throw Error('current build lacks hardware debug');
    support.set(side.label, supported);
  }
  const definitions = [],
    results = [],
    unavailable = [];
  const groups = [];
  for (const row of selected) {
    const key = row.control ? row.kind : row.name;
    let group = groups.find((group) => group.key === key);
    if (!group) {
      group = { key, rows: [] };
      groups.push(group);
    }
    group.rows.push(row);
  }
  for (const group of groups) {
    const active = [];
    try {
      for (const row of group.rows) {
        const loop =
          (row.control && row.kind === 'loop') ||
          ['execute-rf-repair', 'data-write-iret', 'data-multiple-iret'].includes(row.kind);
        const n = BigInt(Math.min(iterations, loop ? 10001 : 501));
        const code = program(row),
          ram = memory(row),
          config = bank(row);
        const retiredPerCycle = row.control
          ? 3n
          : row.kind === 'execute-rf-repair'
            ? 4n
            : row.kind === 'data-write-iret' || row.kind === 'data-multiple-iret'
              ? 3n
              : row.kind === 'gd-guest-clear' || row.kind === 'rep-delivery'
                ? 5n
                : row.kind === 'rep-report'
                  ? 0n
                  : row.kind === 'private-idt-repair' ||
                      row.kind === 'ss-deferred-halt' ||
                      row.kind === 'ss-rep-private-resume'
                    ? 3n
                    : row.kind === 'ss-software-transition'
                      ? 4n
                      : 1n;
        const attemptsPerCycle =
          row.control || row.kind === 'rep-report' || row.kind === 'executable-alias-data'
            ? 0n
            : row.kind === 'private-idt-repair'
              ? 2n
              : row.kind === 'rep-delivery'
                ? 4n
                : 1n;
        definitions.push({
          name: row.name,
          profile: 'protected32',
          code: Array.from(code, (b) => b.toString(16).padStart(2, '0')).join(''),
          iterations: n,
          work: row.control
            ? 3n * n
            : row.kind === 'rep-report'
              ? 2n * n
              : row.kind === 'executable-alias-data'
                ? n
                : attemptsPerCycle * n,
          throughputUnit: row.control
            ? 'guest instructions'
            : row.kind === 'rep-report'
              ? 'repeat elements'
              : row.kind === 'executable-alias-data'
                ? 'watched guest stores'
                : 'automatic entry attempts',
          limits: LIMITS,
          debug: config,
          currentOnly: true,
          controlFamily: row.control ? row.kind : undefined,
          resetBetweenCalls: !loop,
          retiredPerSample: retiredPerCycle * n,
          attemptsPerSample: attemptsPerCycle * n,
          timing: {
            elapsedMs:
              'sum of awaited measured run calls; excludes debug/scalar/context rearming, map repair and output guards',
            wallMs:
              'includes per-cycle host rearming, private repairs and intermediate guards; excludes initial sample setup',
            creationMs:
              'one createCpu per side/workload before sample setup, reused across samples; not independent cold-start samples',
          },
          ceiling:
            'Checked imported protected32 synthetic debug execution. Active misses, private continuations and code/context churn are separately characterized; no equivalent old active-debug baseline or application-throughput claim.',
        });
        for (const side of sides) {
          if (!support.get(side.label)) {
            unavailable.push({
              side: side.label,
              workload: row.name,
              reason:
                'hardware debug bank/projection unavailable; selected active modes and same-build controls are current-only',
            });
            continue;
          }
          const creationAt = performance.now();
          const cpu = await side.createCpu({
            compiler: side.compiler,
            entry: CODE,
            memory: {
              backings: [
                { id: 'code', bytes: code },
                { id: 'ram', bytes: ram },
              ],
              mappings: mappings(row),
            },
            memoryLimits: { maxBackings: 2, maxBackingBytes: RAM_BYTES + 128, maxMappings: 4 },
            limits: LIMITS,
          });
          const creationMs = performance.now() - creationAt;
          const context = cpu.readContext();
          context.mode = 'protected';
          context.segments.cs.long = false;
          context.segments.cs.default32 = true;
          context.segments.ss.default32 = true;
          context.gdtr = { base: GDT, limit: 23 };
          context.idtr = { base: IDT, limit: 0xfff };
          cpu.setContext(context);
          active.push({
            side,
            cpu,
            row,
            n,
            loop,
            code,
            ram,
            config,
            execution: cpu.readContext(),
            retiredPerCycle,
            attemptsPerCycle,
            creationMs,
          });
        }
      }
      for (let sample = 0; sample < samples; sample++)
        for (const entry of (sample + Number(reverse)) % 2 ? [...active].reverse() : active) {
          const {
            side,
            cpu,
            row,
            n,
            loop,
            code,
            ram,
            config,
            execution,
            retiredPerCycle,
            attemptsPerCycle,
            creationMs,
          } = entry;
          checking = row.name;
          const state = initial(row, n),
            expected = structuredClone(state),
            expectedRam = ram.slice(),
            expectedCode = code.slice(),
            expectedBank = structuredClone(config),
            expectedNumeric = numeric(cpu);
          cpu.writeMemory(RAM, ram);
          cpu.setState(state);
          cpu.setDebugState(config);
          const resources = totals(resourceKeys),
            timings = totals(phaseKeys);
          let result,
            elapsedMs = 0,
            calls = 0,
            retired = 0n,
            attempts = 0n,
            repeated = 0n;
          const call = async (budget, repeatBudget, deliveryBudget) => {
            const started = performance.now();
            const r = await cpu.run({
              budget,
              repeatBudget,
              ...(deliveryBudget === undefined
                ? {}
                : { eventDelivery: { budget: deliveryBudget } }),
            });
            elapsedMs += performance.now() - started;
            calls++;
            retired += r.retired;
            attempts += r.deliveryAttempts ?? 0n;
            repeated += r.repeatIterations;
            if (deliveryBudget !== undefined)
              equal(
                r.deliveryAttempts + r.remainingDeliveryBudget,
                deliveryBudget,
                'entry accounting',
              );
            sum(resources, r.resources);
            sum(timings, r.timings);
            return r;
          };
          const began = performance.now();
          if (loop)
            result = await call(
              retiredPerCycle * n,
              0n,
              row.control ? undefined : attemptsPerCycle * n,
            );
          else if (row.kind === 'resume') {
            for (let i = 0n; i < 3n * n; i++) result = await call(1n, 0n);
          } else
            for (let cycle = 0n; cycle < n; cycle++) {
              cpu.setState(state);
              cpu.setDebugState(config);
              if (isRep(row))
                cpu.writeMemory(
                  DESTINATION,
                  ram.subarray(Number(DESTINATION - RAM), Number(DESTINATION - RAM) + 4),
                );
              if (row.kind === 'executable-alias-data') cpu.writeMemory(ALIAS, code.subarray(0, 1));
              if (row.kind === 'ss-rep-private-resume') {
                result = await call(1n, 0n, 0n);
                equal(result.reason, 'budget', 'SS initial budget gate');
                equal(
                  result.state.debugContinuation,
                  { breakpoints: 1, originPc: CODE },
                  'SS data checkpoint',
                );
                equal(cpu.readDebugState().dr6, 0xffff0ff0n, 'deferred status not published');
                result = await call(1n, 1n, 0n);
                equal(result.reason, 'repeat-budget', 'unfinished inhibited REP');
                equal(result.retired, 0n, 'partial REP not retired');
                equal(result.repeatIterations, 1n, 'first element committed');
                equal(
                  result.state.debugContinuation,
                  { breakpoints: 3, originPc: CODE },
                  'old and committed REP masks retained',
                );
                equal(cpu.readDebugState().dr6, 0xffff0ff0n, 'private yield keeps DR6 unselected');
                result = await call(2n, 3n, 1n);
              } else if (row.kind === 'private-idt-repair') {
                const before = cpu.readMemory(STACK - 12n, 12);
                cpu.setMappings(mappings(row, true));
                result = await call(3n, 0n, 1n);
                equal(result.reason, 'system-memory-fault', 'private gate refusal');
                for (const [key, value] of Object.entries({
                  instructionPc: CODE,
                  table: 'idt',
                  vector: 1,
                  address: IDT + 8n,
                  width: 8,
                  phase: 'gate-read',
                  cause: 'permission',
                }))
                  equal(result.systemMemoryFault?.[key], value, `private gate ${key}`);
                equal(result.retired, 0n, 'execute source not retired');
                equal(
                  result.state,
                  {
                    ...state,
                    event: {
                      kind: 'pending',
                      exception: {
                        vector: 1,
                        instructionPc: CODE,
                        returnPc: CODE,
                        savedFlags: 0x202n,
                        debug: { class: 'fault', cause: 'execution-breakpoint', breakpoints: 1 },
                      },
                    },
                  },
                  'frozen execute checkpoint',
                );
                equal(cpu.readMemory(STACK - 12n, 12), before, 'no half frame');
                equal(cpu.readContext(), execution, 'private context atomicity');
                cpu.setMappings(mappings(row));
                result = await call(3n, 0n, 1n);
              } else
                result = await call(
                  row.kind === 'rep-report' ? 1n : retiredPerCycle,
                  isRep(row) ? 4n : 0n,
                  row.kind === 'rep-report' || row.kind === 'executable-alias-data'
                    ? undefined
                    : attemptsPerCycle,
                );
              equal(
                result.reason,
                row.kind === 'rep-report' || row.kind === 'executable-alias-data'
                  ? 'debug-exception'
                  : 'budget',
                'completed debug cycle',
              );
              noFault(result);
            }
          const wallMs = performance.now() - began;
          const report = row.kind === 'rep-report' || row.kind === 'executable-alias-data';
          expected.rip =
            CODE +
            BigInt(
              row.control
                ? 6
                : row.kind === 'execute-rf-repair'
                  ? 3
                  : row.kind === 'data-write-iret' ||
                      row.kind === 'data-multiple-iret' ||
                      row.kind === 'ss-software-transition' ||
                      row.kind === 'ss-rep-private-resume'
                    ? 4
                    : row.kind === 'gd-guest-clear' || row.kind === 'ss-deferred-halt'
                      ? 3
                      : row.kind === 'private-idt-repair'
                        ? 1
                        : row.kind === 'rep-report'
                          ? 0
                          : 2,
            );
          if (row.control) {
            expected.registers[0] = 0x11223344n;
            expected.registers[1] = 0n;
          }
          if (['execute-rf-repair', 'data-write-iret', 'data-multiple-iret'].includes(row.kind))
            expected.registers[1] = 0n;
          if (row.kind === 'gd-guest-clear') {
            expected.registers[0] = 0x11223344n;
            expected.registers[2] = 0xffff2ff0n;
            expectedBank.dr7 = 0x400n;
          } else if (!row.control)
            expectedBank.dr6 =
              row.kind === 'data-multiple-iret' || row.kind === 'ss-rep-private-resume'
                ? 0xffff0ff3n
                : 0xffff0ff1n;
          if (isRep(row)) {
            const count = row.kind === 'rep-report' ? 2n : 4n;
            expected.registers[1] = 4n - count;
            expected.registers[6] = SOURCE + count;
            expected.registers[7] = DESTINATION + count;
            expectedRam.set(
              ram.subarray(Number(SOURCE - RAM), Number(SOURCE - RAM) + Number(count)),
              Number(DESTINATION - RAM),
            );
          }
          if (row.kind === 'data-write-iret' || row.kind === 'data-multiple-iret')
            put(expectedRam, DATA, state.registers[0]);
          if (row.kind === 'executable-alias-data') expectedCode[0] = 0x90;
          if (!row.control && !report) {
            const pc =
              row.kind === 'execute-rf-repair' ||
              row.kind === 'private-idt-repair' ||
              row.kind === 'gd-guest-clear'
                ? CODE
                : row.kind === 'data-write-iret' || row.kind === 'data-multiple-iret'
                  ? CODE + 2n
                  : expected.rip;
            frame(expectedRam, STACK - 12n, [
              pc,
              8n,
              row.kind === 'execute-rf-repair' ||
              row.kind === 'private-idt-repair' ||
              row.kind === 'gd-guest-clear'
                ? 0x10202n
                : 0x202n,
            ]);
            if (row.kind === 'ss-software-transition') {
              frame(expectedRam, STACK - 24n, [SOFTWARE, 8n, 2n]);
            }
          }
          equal(result.reason, report ? 'debug-exception' : 'budget', 'final reason');
          equal(result.state, expected, 'complete scalar/event/interrupt/continuation state');
          equal(retired, retiredPerCycle * n, 'total retired');
          equal(attempts, attemptsPerCycle * n, 'total entry attempts');
          equal(
            repeated,
            isRep(row) ? (row.kind === 'rep-report' ? 2n : 4n) * n : 0n,
            'completed REP elements',
          );
          equal(cpu.readDebugState(), expectedBank, 'complete debug register bank');
          equal(cpu.readContext(), execution, 'complete context');
          equal(cpu.readXmmState(), expectedNumeric.xmm, 'complete XMM bank');
          equal(cpu.readMxcsr(), expectedNumeric.mxcsr, 'MXCSR');
          equal(cpu.readX87State(), expectedNumeric.x87, 'complete raw x87 bank');
          equal(cpu.readMemory(RAM, RAM_BYTES), expectedRam, 'all RAM and frame bytes');
          equal(cpu.readMemory(CODE, 128), expectedCode, 'all source/handler/alias bytes');
          noFault(result);
          if (report) {
            equal(result.debugException?.breakpoints, 1, 'reported current data slot');
            equal(
              result.debugException?.instructionCompleted,
              row.kind !== 'rep-report',
              'partial versus completed report',
            );
            equal(
              result.debugException?.resumeFlags,
              row.kind === 'rep-report' ? 0x10202n : 0x202n,
              'reported RF phase',
            );
          } else equal(result.debugException, undefined, 'no stale debug report');
          const units = cpu.inspectTranslations();
          equal(result.resources.cachedArtifacts, units.length, 'cached artifacts');
          equal(
            result.resources.cachedBytes,
            units.reduce((sum, unit) => sum + unit.byteLength, 0),
            'cached bytes',
          );
          results.push({
            side: side.label,
            workload: row.name,
            sample,
            window: sample === 0 ? 'first' : sample < 4 ? 'early' : 'later',
            elapsedMs,
            wallMs,
            creationMs,
            calls,
            retired,
            deliveryAttempts: attempts,
            repeatIterations: repeated,
            resources: { ...result.resources, ...resources },
            timings,
            state: result.state,
            debug: cpu.readDebugState(),
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
