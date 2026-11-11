export interface FastSystemState {
  star: bigint;
  lstar: bigint;
  fmask: bigint;
  sysenterCs: bigint;
  sysenterEip: bigint;
  sysenterEsp: bigint;
  kernelGsBase: bigint;
}

function record(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('fast-system state must be a record');
}

export function zeroFastSystemState(): FastSystemState {
  return {
    star: 0n,
    lstar: 0n,
    fmask: 0n,
    sysenterCs: 0n,
    sysenterEip: 0n,
    sysenterEsp: 0n,
    kernelGsBase: 0n,
  };
}

export function captureFastSystemState(input: FastSystemState): FastSystemState {
  record(input);
  const result = {
    star: input.star,
    lstar: input.lstar,
    fmask: input.fmask,
    sysenterCs: input.sysenterCs,
    sysenterEip: input.sysenterEip,
    sysenterEsp: input.sysenterEsp,
    kernelGsBase: input.kernelGsBase,
  };
  for (const value of Object.values(result))
    if (typeof value !== 'bigint' || value < 0n || value >= 1n << 64n)
      throw new TypeError('fast-system values must be primitive unsigned64 bigints');
  return result;
}

export function fastSystemStateFromJson(input: unknown): FastSystemState {
  try {
    record(input);
    const word = (value: unknown) => {
      if (typeof value !== 'string' || !/^0x[\da-f]+$/i.test(value))
        throw new TypeError('invalid fast-system word');
      return BigInt(value);
    };
    return captureFastSystemState({
      star: word(input.star),
      lstar: word(input.lstar),
      fmask: word(input.fmask),
      sysenterCs: word(input.sysenterCs),
      sysenterEip: word(input.sysenterEip),
      sysenterEsp: word(input.sysenterEsp),
      kernelGsBase: word(input.kernelGsBase),
    });
  } catch (cause) {
    throw new Error('core returned invalid fast-system state', { cause });
  }
}
