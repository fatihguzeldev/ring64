export interface X87State {
  registers: bigint[];
  controlWord: number;
  statusWord: number;
  tagWord: number;
  instructionPointer: bigint;
  dataPointer: bigint;
  opcode: number;
}

export interface X87Exception {
  instructionPc: bigint;
  vector: 16;
  pending: number;
  controlWord: number;
  statusWord: number;
  instructionPointer: bigint;
  dataPointer: bigint;
  opcode: number;
}

export interface X87Layout {
  offset: number;
  bytes: number;
  registers: number;
  registerBytes: number;
  controlWord: number;
  statusWord: number;
  tagWord: number;
  opcode: number;
  instructionPointer: number;
  dataPointer: number;
}

function word(value: number, maximum: number, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > maximum)
    throw new TypeError(`${name} is outside its unsigned integer range`);
  return value === 0 ? 0 : value;
}

export function captureX87State(input: X87State): X87State {
  if (typeof input !== 'object' || input === null)
    throw new TypeError('x87 state must be a record');
  const source = input.registers;
  if (!Array.isArray(source) || source.length !== 8)
    throw new TypeError('x87 state requires eight physical registers');
  const registers: bigint[] = [];
  for (let i = 0; i < 8; i++) {
    if (!Object.hasOwn(source, i)) throw new TypeError('x87 registers must not be sparse');
    const value = source[i];
    if (typeof value !== 'bigint' || value < 0n || value >= 1n << 80n)
      throw new TypeError('x87 register must be an unsigned 80-bit bigint');
    registers.push(value);
  }
  const controlWord = word(input.controlWord, 0xffff, 'x87 control word');
  const statusWord = word(input.statusWord, 0xffff, 'x87 status word');
  const tagWord = word(input.tagWord, 0xffff, 'x87 tag word');
  const instructionPointer = input.instructionPointer;
  const dataPointer = input.dataPointer;
  for (const value of [instructionPointer, dataPointer])
    if (typeof value !== 'bigint' || value < 0n || value >= 1n << 64n)
      throw new TypeError('x87 pointer must be an unsigned 64-bit bigint');
  const opcode = word(input.opcode, 0x7ff, 'x87 opcode');
  const summary = statusWord & ~controlWord & 0x3f ? 0x8080 : 0;
  if ((statusWord & 0x8080) !== summary)
    throw new TypeError('x87 ES and B must match pending conditions');
  return { registers, controlWord, statusWord, tagWord, instructionPointer, dataPointer, opcode };
}

export function validateX87Layout(value: X87Layout, size: number, after: number): void {
  if (typeof value !== 'object' || value === null)
    throw new Error('core returned an invalid x87 layout');
  for (const name of [
    'offset',
    'bytes',
    'registers',
    'registerBytes',
    'controlWord',
    'statusWord',
    'tagWord',
    'opcode',
    'instructionPointer',
    'dataPointer',
  ] as const)
    if (!Number.isSafeInteger(value[name]) || value[name] < 0 || value[name] > 0xffffffff)
      throw new Error('core returned an invalid x87 layout');
  if (
    value.offset < 456 ||
    value.offset < after ||
    value.bytes !== 104 ||
    value.registerBytes !== 10 ||
    value.offset + value.bytes > size
  )
    throw new Error('core returned an incompatible x87 layout');
  const spans = [
    [value.registers, 80],
    [value.controlWord, 2],
    [value.statusWord, 2],
    [value.tagWord, 2],
    [value.opcode, 2],
    [value.instructionPointer, 8],
    [value.dataPointer, 8],
  ].sort((a, b) => a[0]! - b[0]!);
  let end = 0;
  for (const [start, length] of spans) {
    if (start !== end) throw new Error('core returned overlapping x87 layout fields');
    end = start! + length!;
  }
  if (end !== value.bytes) throw new Error('core returned an invalid x87 layout extent');
}

export function readX87(view: DataView, layout: X87Layout): X87State {
  return {
    registers: Array.from({ length: 8 }, (_, i) => {
      const at = layout.registers + i * layout.registerBytes;
      return view.getBigUint64(at, true) | (BigInt(view.getUint16(at + 8, true)) << 64n);
    }),
    controlWord: view.getUint16(layout.controlWord, true),
    statusWord: view.getUint16(layout.statusWord, true),
    tagWord: view.getUint16(layout.tagWord, true),
    opcode: view.getUint16(layout.opcode, true),
    instructionPointer: view.getBigUint64(layout.instructionPointer, true),
    dataPointer: view.getBigUint64(layout.dataPointer, true),
  };
}

export function writeX87(view: DataView, layout: X87Layout, input: X87State): void {
  for (let i = 0; i < 8; i++) {
    const at = layout.registers + i * layout.registerBytes,
      value = input.registers[i]!;
    view.setBigUint64(at, value & ((1n << 64n) - 1n), true);
    view.setUint16(at + 8, Number(value >> 64n), true);
  }
  view.setUint16(layout.controlWord, input.controlWord, true);
  view.setUint16(layout.statusWord, input.statusWord, true);
  view.setUint16(layout.tagWord, input.tagWord, true);
  view.setUint16(layout.opcode, input.opcode, true);
  view.setBigUint64(layout.instructionPointer, input.instructionPointer, true);
  view.setBigUint64(layout.dataPointer, input.dataPointer, true);
}
