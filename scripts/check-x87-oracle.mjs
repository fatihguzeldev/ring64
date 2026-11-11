import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const args = process.argv.slice(2),
  values = {};
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (!['--current', '--cases'].includes(key) || args[i + 1] === undefined)
    throw Error('require --current BUILT_REPO --cases ORACLE_JSON');
  values[key.slice(2)] = resolve(args[++i]);
}
if (!values.current || !values.cases)
  throw Error('require --current BUILT_REPO --cases ORACLE_JSON');
const report = JSON.parse(await readFile(values.cases, 'utf8'));
if (
  report.kind !== 'independent-exact-rational-raw80-oracle' ||
  !Array.isArray(report.cases) ||
  report.cases.length > 10000
)
  throw Error('invalid/unbounded oracle report');
const { createCpu } = await import(pathToFileURL(resolve(values.current, 'build/host/index.js')));
const bytes = await readFile(resolve(values.current, 'build/ring64.wasm')),
  compiler = await WebAssembly.compile(bytes);
let checked = 0;
for (const [operation, opcode] of [
  ['fprem', 0xf8],
  ['fprem1', 0xf5],
  ['fscale', 0xfd],
]) {
  const cpu = await createCpu({
    compiler,
    code: { base: 0x1000n, bytes: Uint8Array.of(0xd9, opcode) },
    ram: { base: 0x4000n, bytes: new Uint8Array(16) },
    limits: {
      maxInstructions: 8,
      maxSourceBytes: 32,
      maxArtifactBytes: 65536,
      maxCachedArtifacts: 4,
      maxCachedBytes: 262144,
      maxTranslationsPerRun: 4,
    },
  });
  try {
    for (const [index, row] of report.cases.entries()) {
      if (row.operation !== operation) continue;
      cpu.setState({ registers: Array(16).fill(0n), rip: 0x1000n, flags: 2n });
      cpu.setX87State({
        registers: [BigInt(row.a), BigInt(row.b), 0n, 0n, 0n, 0n, 0n, 0n],
        controlWord: row.cw,
        statusWord: 0,
        tagWord: 0xfff0,
        instructionPointer: 0n,
        dataPointer: 0n,
        opcode: 0,
      });
      const result = await cpu.run({ budget: 1n }),
        state = cpu.readX87State();
      if (
        result.retired !== 1n ||
        result.reason !== 'budget' ||
        result.state.rip !== 0x1002n ||
        result.state.flags !== 2n ||
        state.registers[0] !== BigInt(row.raw) ||
        state.registers[1] !== BigInt(row.b) ||
        state.statusWord !== row.sw
      )
        throw Error(
          JSON.stringify({
            index,
            row,
            actual: {
              reason: result.reason,
              raw: state.registers[0].toString(16),
              sw: state.statusWord.toString(16),
            },
          }),
        );
      checked++;
    }
  } finally {
    cpu.dispose();
  }
}
if (checked !== report.cases.length) throw Error('unrecognized operation in oracle');
console.log(
  JSON.stringify({
    checked,
    coreSha256: createHash('sha256').update(bytes).digest('hex'),
    seeds: report.seeds,
    ceiling: report.ceiling,
  }),
);
