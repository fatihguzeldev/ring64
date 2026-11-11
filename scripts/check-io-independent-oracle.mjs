import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { freeze, manifest, encode } from './paging-support.mjs';

const values = {},
  args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (!['--current', '--output'].includes(args[i]) || args[i + 1] === undefined)
    throw Error('require --current BUILT_REPO [--output FILE]');
  values[args[i].slice(2)] = resolve(args[++i]);
}
if (!values.current) throw Error('require --current BUILT_REPO [--output FILE]');
const snapshot = await freeze(values.current, `independent-io-${Date.now()}-${process.pid}`);
const { createCpu } = await import(pathToFileURL(resolve(snapshot.path, 'build/host/index.js')));
const compiler = await WebAssembly.compile(
  await readFile(resolve(snapshot.path, 'build/ring64.wasm')),
);
const limits = {
  maxInstructions: 16,
  maxSourceBytes: 128,
  maxArtifactBytes: 65536,
  maxCachedArtifacts: 4,
  maxCachedBytes: 262144,
  maxTranslationsPerRun: 4,
};

// The expected banks, traces, masks and RAM bytes below use only literal bytes and integer arithmetic.
// They import no instruction decoder, I/O semantic helper or shared execution-test fixture.
async function checkStrings() {
  const modes = [];
  for (const mode of ['long64', 'protected', 'compatibility', 'real']) {
    for (const code32 of mode === 'long64' ? [true] : [false, true])
      for (const addressWidth of mode === 'long64' ? [32, 64] : [16, 32])
        modes.push({ mode, code32, addressWidth });
  }
  function context({ mode, code32 }) {
    if (mode === 'long64') return { mode, fsBase: 0n, gsBase: 0n };
    return {
      mode,
      segments: Object.fromEntries(
        ['cs', 'ss', 'ds', 'es', 'fs', 'gs'].map((name) => [
          name,
          {
            base: 0n,
            limit: 0xffffffff,
            default32: name === 'cs' ? code32 : true,
            usable: true,
            type: name === 'cs' ? 'readable-code' : 'read-write',
          },
        ]),
      ),
    };
  }
  function bankAfter(original, selected, width, long64) {
    const mask = (1n << BigInt(width)) - 1n;
    return (width === 64 || (width === 32 && long64) ? 0n : original & ~mask) | (selected & mask);
  }
  function setValue(bytes, at, value, width) {
    for (let i = 0; i < width / 8; i++)
      bytes[at + i] = Number((BigInt(value) >> BigInt(i * 8)) & 255n);
  }
  let checked = 0;
  for (const profile of modes)
    for (const width of [8, 16, 32])
      for (const descending of [false, true])
        for (const input of [false, true])
          for (const repeated of [false, true]) {
            const { mode, code32, addressWidth } = profile,
              long64 = mode === 'long64',
              size = width / 8;
            const operandDefault = long64 || code32 ? 32 : 16,
              addressDefault = long64 ? 64 : code32 ? 32 : 16;
            const prefix = [
              ...(width !== 8 && width !== operandDefault ? [0x66] : []),
              ...(addressWidth !== addressDefault ? [0x67] : []),
              ...(repeated ? [0xf3] : []),
            ];
            const opcode = input ? (width === 8 ? 0x6c : 0x6d) : width === 8 ? 0x6e : 0x6f,
              code = Uint8Array.of(...prefix, opcode);
            const ram = new Uint8Array(0x3000).fill(0xa5),
              expected = ram.slice();
            const values =
              width === 8
                ? [0x12, 0x34, 0xab]
                : width === 16
                  ? [0x1234, 0x4567, 0xcdef]
                  : [0x89abcdef, 0xfedcba98, 0x80000001];
            const n = repeated ? 3 : 1,
              index = input ? 7 : 6,
              direction = descending ? -1 : 1;
            for (let j = 0; j < n; j++)
              if (!input) setValue(ram, 0x1000 + j * size * direction, values[j], width);
            if (!input) expected.set(ram);
            let calls = 0;
            const cpu = await createCpu({
              compiler,
              limits,
              context: context(profile),
              code: { base: 0x1000n, bytes: code },
              ram: { base: 0x7000n, bytes: ram },
              io: {
                read(port, bits) {
                  assert.equal(input, true);
                  assert.equal(port, 0x81);
                  assert.equal(bits, width);
                  return values[calls++];
                },
                write(port, bits, value) {
                  assert.equal(input, false);
                  assert.equal(port, 0x81);
                  assert.equal(bits, width);
                  assert.equal(value, values[calls++]);
                },
              },
            });
            try {
              const registers = Array.from(
                { length: 16 },
                (_, i) => 0x1020304050600000n + BigInt(i),
              );
              registers[1] =
                (addressWidth === 64 ? 0n : 0x1122334400000000n) | (repeated ? 3n : 0xdeadn);
              registers[2] = 0xffff000000000081n;
              registers[index] = (addressWidth === 64 ? 0n : 0x1122334400000000n) | 0x8000n;
              const flags = 0x10002n | (descending ? 0x400n : 0n),
                banks = registers.slice();
              cpu.setState({ registers, flags, rip: 0x1000n });
              const first = await cpu.run({ budget: 1n, repeatBudget: repeated ? 2n : 0n });
              const done = repeated ? 2 : 1;
              assert.equal(first.reason, repeated ? 'repeat-budget' : 'budget');
              assert.equal(first.retired, repeated ? 0n : 1n);
              assert.equal(first.repeatIterations, BigInt(repeated ? 2 : 0));
              assert.equal(calls, done);
              banks[index] = bankAfter(
                registers[index],
                0x8000n + BigInt(direction * size * done),
                addressWidth,
                long64,
              );
              if (repeated) banks[1] = bankAfter(registers[1], 1n, addressWidth, long64);
              assert.deepEqual(first.state.registers, banks);
              assert.equal(first.state.flags, flags & ~0x10000n);
              assert.equal(first.state.rip, repeated ? 0x1000n : 0x1000n + BigInt(code.length));
              if (input)
                for (let j = 0; j < done; j++)
                  setValue(expected, 0x1000 + j * size * direction, values[j], width);
              assert.deepEqual(cpu.readMemory(0x7000n, expected.length), expected);
              if (repeated) {
                const last = await cpu.run({ budget: 1n, repeatBudget: 1n });
                assert.equal(last.reason, 'budget');
                assert.equal(last.retired, 1n);
                assert.equal(last.repeatIterations, 1n);
                assert.equal(calls, 3);
                banks[index] = bankAfter(
                  registers[index],
                  0x8000n + BigInt(direction * size * 3),
                  addressWidth,
                  long64,
                );
                banks[1] = bankAfter(registers[1], 0n, addressWidth, long64);
                assert.deepEqual(last.state.registers, banks);
                assert.equal(last.state.rip, 0x1000n + BigInt(code.length));
                if (input) setValue(expected, 0x1000 + 2 * size * direction, values[2], width);
                assert.deepEqual(cpu.readMemory(0x7000n, expected.length), expected);
              }
              checked++;
            } catch (error) {
              error.message =
                JSON.stringify({ profile, width, descending, input, repeated, calls }) +
                ' ' +
                error.message;
              throw error;
            } finally {
              cpu.dispose();
            }
          }
  return checked;
}

async function checkPermissions() {
  const template = await createCpu({
    compiler,
    limits,
    code: { base: 0x1000n, bytes: Uint8Array.of(0x90) },
    ram: { base: 0x4000n, bytes: new Uint8Array(1) },
  });
  const context = template.readContext();
  template.dispose();
  context.cpl = 3;
  for (const segment of Object.values(context.segments)) {
    segment.dpl = 3;
    segment.selector |= 3;
  }
  context.tr = { selector: 0x28, valid: true, base: 0x8000n, limit: 0x10000, attributes: 0x8b };
  let seed = 0x77384a21,
    checked = 0;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (const width of [8, 16, 32]) {
    const code = width === 8 ? [0xec] : width === 16 ? [0x66, 0xed] : [0xed],
      ram = new Uint8Array(0x12001);
    let calls = 0;
    const cpu = await createCpu({
      compiler,
      limits,
      context,
      code: { base: 0x1000n, bytes: Uint8Array.from(code) },
      ram: { base: 0x8000n, bytes: ram },
      io: {
        read(port, bits) {
          assert.equal(bits, width);
          calls++;
          return width === 32 ? 0x89abcdef : width === 16 ? 0xbeef : 0xab;
        },
        write() {
          throw Error('no output');
        },
      },
    });
    try {
      for (let i = 0; i < 2048; i++) {
        const port =
          i < 16
            ? i
            : [0, 7, 8, 15, 0xfffc, 0xfffd, 0xfffe, 0xffff, random() & 0xffff][random() % 9];
        const chosenBase = [0, 0x66, 0x67, 0x80, 0xf000, 0xffff][random() % 6],
          mask = i < 16 ? 1 << i : random() & 0xffff;
        ram.fill(0);
        const view = new DataView(ram.buffer);
        view.setUint16(0x66, chosenBase, true);
        view.setUint16(chosenBase + (port >> 3), mask, true);
        const liveBase = view.getUint16(0x66, true),
          offset = liveBase + (port >> 3);
        const denied =
          liveBase >= context.tr.limit ||
          offset + 1 > context.tr.limit ||
          Boolean(view.getUint16(offset, true) & (((1 << (width / 8)) - 1) << (port & 7)));
        const expected = denied
          ? 'protection-fault'
          : port + width / 8 > 65536
            ? 'unsupported'
            : 'budget';
        cpu.writeMemory(0x8000n, ram);
        const regs = Array(16).fill(0x123456789abcdef0n);
        regs[2] = 0xffff000000000000n | BigInt(port);
        cpu.setState({ registers: regs, flags: 0x10002n, rip: 0x1000n });
        calls = 0;
        const result = await cpu.run({ budget: 1n });
        assert.equal(
          result.reason,
          expected,
          JSON.stringify({ width, i, port, chosenBase, liveBase, offset, mask, expected }),
        );
        assert.equal(calls, expected === 'budget' ? 1 : 0);
        assert.equal(result.retired, expected === 'budget' ? 1n : 0n);
        assert.equal(result.state.flags, 2n);
        if (expected === 'protection-fault') {
          assert.equal(result.protectionFault.vector, 13);
          assert.equal(result.protectionFault.errorCode, 0);
          assert.equal(result.protectionFault.selector, undefined);
        }
        if (expected === 'budget') {
          const actual =
            width === 32
              ? 0x89abcdefn
              : (regs[0] & ~((1n << BigInt(width)) - 1n)) | BigInt(width === 16 ? 0xbeef : 0xab);
          assert.equal(result.state.registers[0], actual);
        }
        checked++;
      }
    } finally {
      cpu.dispose();
    }
  }
  return checked;
}

const strings = await checkStrings(),
  permissions = await checkPermissions();
const after = await manifest(snapshot.path);
assert.equal(after.coreSha256, snapshot.coreSha256);
assert.equal(after.hostSha256, snapshot.hostSha256);
const report = {
  kind: 'independent-public-io-oracle',
  snapshot,
  cases: { strings, permissions, total: strings + permissions },
  permissionSeed: '0x77384a21',
  ceiling:
    'Public-runtime literal/integer oracle for cross-width partial string progress and live permission masks. No native-hardware, timing, arbitrary provider or hidden physical-read instrumentation claim.',
};
if (values.output) await writeFile(values.output, encode(report));
console.log(
  JSON.stringify({
    cases: report.cases,
    coreSha256: snapshot.coreSha256,
    hostSha256: snapshot.hostSha256,
    source: snapshot.source,
    ceiling: report.ceiling,
  }),
);
