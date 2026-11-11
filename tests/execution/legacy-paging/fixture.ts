import { createCpu, type Cpu, type Options, type PagingState } from '../../../host/index.js';
import { protectedSnapshot } from '../../support/context.js';
import { LIMITS, hex } from '../../support/fixture.js';
export { check, equal, hex, initial, type Scenario } from '../../support/fixture.js';
export { protectedSnapshot } from '../../support/context.js';
export type { Cpu, PagingState } from '../../../host/index.js';

export function little(word: bigint, width = 8): Uint8Array {
  return Uint8Array.from({ length: width }, (_, i) => Number((word >> BigInt(i * 8)) & 255n));
}
export function word(cpu: Cpu, address: bigint, width = 8): bigint {
  const bytes = cpu.readPhysicalMemory(address, width);
  let value = 0n;
  for (let i = width - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i]!);
  return value;
}
export function legacyOptions(
  compiler: WebAssembly.Module,
  pae = false,
  code = '90',
  pdptBacked = true,
): Options {
  const bytes = new Uint8Array(0x10000);
  const put = (at: number, value: bigint, width: number) => bytes.set(little(value, width), at);
  if (pae) {
    put(0x1000, 0x3001n, 8);
    put(0x3000, 0x4007n, 8);
    put(0x4008, 0x8007n, 8);
    put(0x4030, 0xa007n, 8);
    put(0x5000, 0x6007n, 8);
    put(0x6008, 0x8007n, 8);
    put(0x6030, 0xb007n, 8);
  } else {
    put(0x1000, 0x2007n, 4);
    put(0x2004, 0x8007n, 4);
    put(0x2018, 0xa007n, 4);
  }
  bytes.set(hex(code), 0x8000);
  const base = pae && !pdptBacked ? 0x2000 : 0;
  const paging: PagingState = {
    cr0: 0x80000033n,
    cr2: 0n,
    cr3: 0x1000n,
    cr4: pae ? 0x628n : 0x608n,
    efer: 0n,
    ...(pae ? { pdpte: [0x3001n, 0n, 0n, 0n] as [bigint, bigint, bigint, bigint] } : {}),
  };
  return {
    compiler,
    memoryModel: 'physical',
    context: protectedSnapshot(),
    paging,
    memory: {
      backings: [{ id: 'ram', bytes }],
      mappings: [
        {
          base: BigInt(base),
          backing: 'ram',
          offset: base,
          length: bytes.length - base,
          permissions: { read: true, write: true, execute: true },
        },
      ],
    },
    entry: 0x1000n,
    memoryLimits: { maxBackings: 4, maxBackingBytes: 0x20000, maxMappings: 16 },
    limits: { ...LIMITS },
  };
}
export async function legacyCpu(
  compiler: WebAssembly.Module,
  pae = false,
  code = '90',
  pdptBacked = true,
): Promise<Cpu> {
  return createCpu(legacyOptions(compiler, pae, code, pdptBacked));
}
