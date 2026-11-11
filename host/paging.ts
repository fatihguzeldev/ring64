export interface PagingState {
  cr0: bigint;
  cr2: bigint;
  cr3: bigint;
  cr4: bigint;
  efer: bigint;
  pdpte?: [bigint, bigint, bigint, bigint];
}

function record(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('paging state must be a record');
}

export function capturePagingState(input: PagingState): PagingState {
  record(input);
  const result = {
    cr0: input.cr0,
    cr2: input.cr2,
    cr3: input.cr3,
    cr4: input.cr4,
    efer: input.efer,
  };
  for (const value of Object.values(result))
    if (typeof value !== 'bigint' || value < 0n || value >= 1n << 64n)
      throw new TypeError('paging values must be primitive unsigned64 bigints');
  if ('pdpte' in input) {
    const source = input.pdpte;
    if (!Array.isArray(source) || source.length !== 4)
      throw new TypeError('captured PDPTEs require exactly four own words');
    const words: bigint[] = [];
    for (let index = 0; index < 4; index++) {
      if (!Object.hasOwn(source, index)) throw new TypeError('captured PDPTE has a hole');
      const value = source[index];
      if (typeof value !== 'bigint' || value < 0n || value >= 1n << 64n)
        throw new TypeError('captured PDPTE must be a primitive unsigned64 bigint');
      words.push(value);
    }
    return { ...result, pdpte: words as [bigint, bigint, bigint, bigint] };
  }
  return result;
}

export function pagingStateFromJson(input: unknown): PagingState {
  try {
    record(input);
    const word = (value: unknown) => {
      if (typeof value !== 'string' || !/^0x[\da-f]+$/i.test(value))
        throw new TypeError('invalid paging word');
      return BigInt(value);
    };
    const result = {
      cr0: word(input.cr0),
      cr2: word(input.cr2),
      cr3: word(input.cr3),
      cr4: word(input.cr4),
      efer: word(input.efer),
    };
    if ('pdpte' in input) {
      if (!Array.isArray(input.pdpte)) throw new TypeError('invalid captured PDPTE shape');
      return capturePagingState({
        ...result,
        pdpte: input.pdpte.map(word) as [bigint, bigint, bigint, bigint],
      });
    }
    return capturePagingState(result);
  } catch (cause) {
    throw new Error('core returned invalid paging state', { cause });
  }
}
