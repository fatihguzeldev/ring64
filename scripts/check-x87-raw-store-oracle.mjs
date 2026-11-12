import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const values = {},
  args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const key = args[i],
    value = args[i + 1];
  if (
    !['--current', '--output'].includes(key) ||
    value === undefined ||
    value.startsWith('--') ||
    values[key.slice(2)] !== undefined
  )
    throw Error('require --current BUILT_REPO [--output FILE]');
  values[key.slice(2)] = resolve(value);
  i++;
}
if (!values.current) throw Error('require --current BUILT_REPO [--output FILE]');
const current = values.current,
  output = values.output;
const sha = (value) => createHash('sha256').update(value).digest('hex');
async function hostSha256() {
  const digest = createHash('sha256');
  for (const file of (await readdir(resolve(current, 'build/host')))
    .filter((x) => x.endsWith('.js'))
    .sort()) {
    digest.update(file + '\0');
    digest.update(await readFile(resolve(current, 'build/host', file)));
  }
  return digest.digest('hex');
}
const coreBytes = await readFile(resolve(current, 'build/ring64.wasm'));
const before = { coreSha256: sha(coreBytes), hostSha256: await hostSha256() };
const { createCpu } = await import(pathToFileURL(resolve(current, 'build/host/index.js')));
const compiler = await WebAssembly.compile(coreBytes);
const PC = 0x1000n,
  DATA = 0x6000n,
  INDEFINITE = 0xffffc000000000000000n;
const classes = [
  ['positive-zero', 0x00000000000000000000n, 1],
  ['negative-zero', 0x80000000000000000000n, 1],
  ['positive-finite', 0x3fff8000000000000001n, 0],
  ['negative-finite', 0xbfff8123456789abcdefn, 0],
  ['subnormal', 0x00000000000000000001n, 2],
  ['pseudo-denormal', 0x00008000000000000001n, 2],
  ['positive-infinity', 0x7fff8000000000000000n, 2],
  ['negative-infinity', 0xffff8000000000000000n, 2],
  ['quiet-nan', 0x7fffc000000000000011n, 2],
  ['signaling-nan', 0xffff8000000000000011n, 2],
  ['unsupported', 0x3fff0000000000000001n, 2],
  ['pseudo-infinity', 0x7fff0000000000000000n, 2],
];
const forms = [
  { name: 'fst-st1', bytes: [0xdd, 0xd1], pop: false, memory: false, fop: 0x5d1 },
  { name: 'fstp-st1', bytes: [0xdd, 0xd9], pop: true, memory: false, fop: 0x5d9 },
  { name: 'fstp-m80', bytes: [0xdb, 0x3b], pop: true, memory: true, fop: 0x33b },
];
const modes = [
  { name: 'rf', flags: 0x10002n, step: false, watch: false },
  { name: 'tf-rf', flags: 0x10302n, step: true, watch: false },
  { name: 'last-byte-dr-rf', flags: 0x10002n, step: false, watch: true },
  { name: 'tf-last-byte-dr-rf', flags: 0x10302n, step: true, watch: true },
];
const setTag = (word, physical, tag) =>
  ((word & ~(3 << (physical * 2))) | (tag << (physical * 2))) & 0xffff;
const little = (raw, size) =>
  Uint8Array.from({ length: size }, (_, i) => Number((raw >> BigInt(i * 8)) & 255n));
const xmm = Array.from({ length: 16 }, (_, i) => (1n << 120n) | BigInt(i + 1));
let cases = 0,
  retired = 0,
  traps = 0,
  committedStores = 0,
  suppressedStores = 0,
  emptyCases = 0;
let activeCase;
const debugShapes = {};
try {
  for (const form of forms)
    for (const mode of modes) {
      const cpu = await createCpu({
        compiler,
        code: { base: PC, bytes: Uint8Array.from(form.bytes) },
        ram: { base: DATA, bytes: new Uint8Array(16).fill(0xa5) },
        limits: {
          maxInstructions: 4,
          maxSourceBytes: 32,
          maxArtifactBytes: 16384,
          maxCachedArtifacts: 4,
          maxCachedBytes: 131072,
          maxTranslationsPerRun: 4,
        },
      });
      try {
        for (const [className, raw, sourceTag] of [
          ...classes,
          ['empty', 0xffff8000000000000055n, 3],
        ])
          for (let top = 0; top < 8; top++)
            for (const cw of [0x37f, 0x37e]) {
              activeCase = { form: form.name, mode: mode.name, className, top, cw };
              const empty = sourceTag === 3,
                masked = (cw & 1) !== 0;
              const publishes = !empty || masked;
              const actualPop = form.pop && publishes;
              const destination = (top + 1) & 7;
              const before = {
                registers: Array.from({ length: 8 }, (_, i) => 0x40408000000000001000n + BigInt(i)),
                controlWord: cw,
                statusWord: (top << 11) | 0x4700,
                tagWord: setTag(0xffff, top, sourceTag),
                opcode: 0x321,
                instructionPointer: 0x1122334455667788n,
                dataPointer: 0x8877665544332211n,
              };
              before.registers[top] = raw;
              const expected = { ...before, registers: before.registers.slice() };
              const value = empty ? INDEFINITE : raw;
              expected.instructionPointer = PC;
              if (form.memory) expected.dataPointer = DATA;
              if (empty && !masked) expected.opcode = form.fop;
              expected.statusWord = (top << 11) | 0x4500 | (empty ? (masked ? 0x41 : 0x80c1) : 0);
              if (!form.memory && publishes) {
                expected.registers[destination] = value;
                expected.tagWord = setTag(expected.tagWord, destination, empty ? 2 : sourceTag);
              }
              if (actualPop) {
                expected.tagWord = setTag(expected.tagWord, top, 3);
                expected.statusWord = (expected.statusWord & ~0x3800) | (((top + 1) & 7) << 11);
              }
              const gpr = Array.from({ length: 16 }, (_, i) => 0x1122334400000000n + BigInt(i));
              gpr[3] = DATA;
              cpu.setState({ rip: PC, flags: mode.flags, registers: gpr });
              cpu.setX87State(before);
              cpu.setXmmState(xmm);
              cpu.setMxcsr(0x5fa5);
              cpu.setDebugState({
                addresses: [DATA + 9n, 0n, 0n, 0n],
                dr6: 0n,
                dr7: mode.watch ? 0x10401n : 0x400n,
              });
              cpu.writeMemory(DATA, new Uint8Array(16).fill(0xa5));
              const r = await cpu.run({ budget: 1n, repeatBudget: 0n });
              const hit = mode.watch && form.memory && publishes;
              const trap = mode.step || hit;
              assert.equal(r.reason, trap ? 'debug-exception' : 'budget');
              assert.equal(r.retired, 1n);
              assert.equal(r.remaining, 0n);
              assert.equal(r.repeatIterations, 0n);
              assert.equal(r.remainingRepeatBudget, 0n);
              assert.equal(r.state.rip, PC + 2n);
              assert.equal(r.state.flags, mode.flags & ~0x10000n);
              assert.deepEqual(r.state.registers, gpr);
              assert.deepEqual(r.state.event, { kind: 'ready' });
              for (const key of [
                'fault',
                'segmentFault',
                'alignmentFault',
                'x87Exception',
                'simdException',
                'numericControlFault',
                'deviceNotAvailable',
              ])
                assert.equal(r[key], undefined, key);
              if (trap) {
                assert.equal(r.debugException.vector, 1);
                assert.equal(r.debugException.class, 'trap');
                if (hit) {
                  assert.equal(r.debugException.cause, mode.step ? 'combined' : 'data-breakpoint');
                  assert.equal(r.debugException.singleStep, mode.step);
                  assert.equal(r.debugException.breakpoints, 1);
                } else {
                  assert.equal(mode.step, true);
                  assert.equal(r.debugException.cause, 'single-step');
                  assert.equal(r.debugException.singleStep, undefined);
                  assert.equal(r.debugException.breakpoints, undefined);
                }
                debugShapes[r.debugException.cause] ??= Object.keys(r.debugException).sort();
                assert.equal(r.debugException.instructionCompleted, true);
                assert.equal(r.debugException.instructionPc, PC);
                assert.equal(r.debugException.resumePc, PC + 2n);
                assert.equal(r.debugException.resumeFlags, r.state.flags);
                traps++;
              } else assert.equal(r.debugException, undefined);
              assert.equal(
                cpu.readDebugState().dr6,
                0xffff0ff0n | (mode.step ? 0x4000n : 0n) | (hit ? 1n : 0n),
              );
              const actual = cpu.readX87State();
              assert.equal(actual.controlWord, expected.controlWord);
              // C0/C2/C3 are architecturally undefined for these producers; all defined status bits remain checked.
              assert.equal(actual.statusWord & 0xbaff, expected.statusWord & 0xbaff);
              for (const key of ['tagWord', 'opcode', 'instructionPointer', 'dataPointer'])
                assert.equal(actual[key], expected[key], key);
              assert.deepEqual(actual.registers, expected.registers);
              assert.deepEqual(cpu.readXmmState(), xmm);
              assert.equal(cpu.readMxcsr(), 0x5fa5);
              const memory = new Uint8Array(16).fill(0xa5);
              if (form.memory && publishes) {
                memory.set(little(value, 10));
                committedStores++;
              }
              if (form.memory && !publishes) suppressedStores++;
              assert.deepEqual(cpu.readMemory(DATA, 16), memory);
              if (empty) emptyCases++;
              cases++;
              retired++;
            }
      } finally {
        cpu.dispose();
      }
    }
} catch (error) {
  console.error('probe case', activeCase);
  throw error;
}
assert.equal(cases, 2496);
const report = {
  kind: 'independent-actual-wasm-raw-store-probe',
  current,
  coreSha256: before.coreSha256,
  hostSha256: before.hostSha256,
  probeSha256: sha(await readFile(new URL(import.meta.url))),
  debugShapes,
  deterministic: true,
  seed: null,
  oracleCorrection:
    'Initial probe incorrectly required optional singleStep/breakpoints on legacy TF-only reports. Corrected to exact cause-discriminated shape from the unchanged public contract; initial script/log preserved separately.',
  classLiterals: classes.map(([name, raw, tag]) => ({ name, raw: '0x' + raw.toString(16), tag })),
  controls: [0x37f, 0x37e],
  topValues: [0, 1, 2, 3, 4, 5, 6, 7],
  forms,
  modes: modes.map((x) => ({ ...x, flags: '0x' + x.flags.toString(16) })),
  totals: { cases, retired, traps, committedStores, suppressedStores, emptyCases },
  checked: [
    'literal raw80 payload/classes',
    'all physical registers/tags/TOP',
    'defined status including C1 and pending bits',
    'pop and suppression',
    'FIP/FDP/FOP publication',
    'RF clearing',
    'TF and last-byte DR completion/aggregation',
    'scalar/XMM/MXCSR preservation',
    'complete10B output plus6B guard',
    'empty-source masked/unmasked response',
  ],
  ceiling:
    'Finite public-Wasm corroboration; no production arithmetic/decoder fixture used as oracle, no native hardware or performance claim. C0/C2/C3 undefined bits masked. No paging alias claim; existing independent alias fixtures own that boundary.',
};
assert.equal(
  sha(await readFile(resolve(current, 'build/ring64.wasm'))),
  before.coreSha256,
  'Core artifact changed during raw-store oracle',
);
assert.equal(
  await hostSha256(),
  before.hostSha256,
  'host artifacts changed during raw-store oracle',
);
if (output) await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify({
    output,
    ...report.totals,
    coreSha256: report.coreSha256,
    hostSha256: report.hostSha256,
  }),
);
