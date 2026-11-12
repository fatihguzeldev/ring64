export interface TimeState {
  tsc: bigint;
  tscAux: number;
}

export interface TimeLayout {
  offset: number;
  size: number;
  tsc: number;
  tscAux: number;
}

export function captureTimeState(input: TimeState): TimeState {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new TypeError('time state must be a record');
  const { tsc, tscAux } = input;
  if (typeof tsc !== 'bigint' || tsc < 0n || tsc >= 1n << 64n)
    throw new TypeError('TSC must be a primitive unsigned64 bigint');
  if (typeof tscAux !== 'number' || !Number.isInteger(tscAux) || tscAux < 0 || tscAux > 0xffffffff)
    throw new TypeError('TSC AUX must be an unsigned32 number');
  return { tsc, tscAux: tscAux === 0 ? 0 : tscAux };
}

export function validateTimeLayout(
  input: TimeLayout,
  stateSize: number,
  precedingEnd: number,
): void {
  if (
    typeof input !== 'object' ||
    input === null ||
    [input.offset, input.size, input.tsc, input.tscAux].some(
      (value) => !Number.isSafeInteger(value) || value < 0 || value > 0xffffffff,
    ) ||
    input.offset < precedingEnd ||
    input.offset + input.size > stateSize ||
    input.tsc + 8 > input.size ||
    input.tscAux < input.tsc + 8 ||
    input.tscAux + 4 > input.size
  )
    throw new Error('core returned an invalid time layout');
}
