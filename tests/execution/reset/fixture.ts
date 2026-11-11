import { createCpu, type ExecutionContextSnapshot, type PagingState } from '../../../host/index.js';
import { LIMITS, hex } from '../../support/fixture.js';
export { equal, hex, type Scenario } from '../../support/fixture.js';
export { createCpu } from '../../../host/index.js';
export const RESET_BANK: PagingState = { cr0: 0x60000010n, cr2: 0n, cr3: 0n, cr4: 0n, efer: 0n };
export function resetContext(): ExecutionContextSnapshot {
  const data = () => ({
    selector: 0,
    base: 0n,
    limit: 0xffff,
    default32: false,
    usable: true,
    type: 'read-write' as const,
    dpl: 0,
    present: true,
    conforming: false,
    accessed: true,
    long: false,
    granularity: false,
    available: false,
  });
  return {
    mode: 'real',
    cpl: 0,
    segments: {
      cs: { ...data(), selector: 0xf000, base: 0xffff0000n },
      ss: data(),
      ds: data(),
      es: data(),
      fs: data(),
      gs: data(),
    },
    gdtr: { base: 0n, limit: 0xffff },
    idtr: { base: 0n, limit: 0xffff },
    ldtr: { selector: 0, valid: false, base: 0n, limit: 0xffff, attributes: 0 },
    tr: { selector: 0, valid: false, base: 0n, limit: 0xffff, attributes: 0 },
  };
}
export function put(bytes: Uint8Array, at: number, value: bigint, width = 8): void {
  for (let i = 0; i < width; i++) bytes[at + i] = Number((value >> BigInt(i * 8)) & 255n);
}
export async function physicalCpu(
  compiler: WebAssembly.Module,
  ram: Uint8Array,
  rom: Uint8Array,
  paging = RESET_BANK,
  context = resetContext(),
) {
  return createCpu({
    compiler,
    memoryModel: 'physical',
    context,
    paging,
    entry: 0xfff0n,
    memory: {
      backings: [
        { id: 'ram', bytes: ram },
        { id: 'rom', bytes: rom },
      ],
      mappings: [
        {
          base: 0n,
          backing: 'ram',
          offset: 0,
          length: ram.length,
          permissions: { read: true, write: true, execute: true },
        },
        {
          base: 0xffff0000n,
          backing: 'rom',
          offset: 0,
          length: rom.length,
          permissions: { read: true, write: false, execute: true },
        },
      ],
    },
    memoryLimits: {
      maxBackings: 4,
      maxMappings: 8,
      maxBackingBytes: ram.length + rom.length + 0x1000,
    },
    limits: { ...LIMITS, maxTranslationsPerRun: 1000 },
  });
}
export function transitionProgram() {
  const ram = new Uint8Array(0x100000),
    rom = new Uint8Array(0x10000);
  rom.set(hex('ea00000010'), 0xfff0);
  ram.set(hex('270000000300'), 0x10200);
  for (const [i, image] of [
    '0000000000000000',
    'ffff0000009bcf00',
    'ffff00000093cf00',
    'ffff0000009baf00',
    'ffff0000009b0000',
  ].entries())
    ram.set(hex(image), 0x30000 + i * 8);
  for (const [address, code] of [
    [
      0x10000,
      'b80010 8ed8 0f01160002 66b808060000 0f22e0 dbe3 0f20c0 6625ffffff9f 6683c823 0f22c0 66ea000002000800',
    ],
    [
      0x20000,
      '66b81000 8ed8 8ec0 8ed0 bc00900000 b800100300 0f22d8 0f20c0 0d00000080 0f22c0 c7050060000011111111 0f20c0 25ffffff7f 0f22c0 b800600300 0f22d8 0f20e0 83c820 0f22e0 0f20c0 0d00000080 0f22c0 c7050060000022222222 0f20c0 25ffffff7f 0f22c0 b800b00300 0f22d8 b9800000c0 0f32 0d00010000 0f30 0f20c0 0d00000080 0f22c0 c7050060000033333333 ea001002001800',
    ],
    [0x21000, 'b844444444 c704250460000044444444 48ff2c2500500200'],
    [
      0x22000,
      '0f20c0 25ffffff7f 0f22c0 b9800000c0 0f32 25fffeffff 0f30 0f20e0 83e0df 0f22e0 c7050060000055555555 ea002300002000',
    ],
    [0x2300, '0f20c0 6683e0fe 0f22c0 ea00040010'],
    [0x10400, 'b8efbe'],
  ] as const)
    ram.set(hex(code.replaceAll(' ', '')), address);
  ram.set(hex('00200200000000000800'), 0x25000);
  put(ram, 0x31000, 0x32003n, 4);
  put(ram, 0x36000, 0x37001n);
  put(ram, 0x37000, 0x38003n);
  put(ram, 0x3b000, 0x3c003n);
  put(ram, 0x3c000, 0x3d003n);
  put(ram, 0x3d000, 0x3e003n);
  for (let i = 0; i < 0x40; i++) {
    put(ram, 0x32000 + i * 4, i === 6 ? 0x90003n : BigInt(i << 12) | 3n, 4);
    put(ram, 0x38000 + i * 8, i === 6 ? 0x91003n : BigInt(i << 12) | 3n);
    put(ram, 0x3e000 + i * 8, i === 6 ? 0x92003n : BigInt(i << 12) | 3n);
  }
  return { ram, rom };
}
