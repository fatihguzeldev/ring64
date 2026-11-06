import type { RunResult } from '../../../host/index.js';
import { initial, equal, CODE } from '../../support/fixture.js';

export const defaultRam = { ramBase: 0x4000n, ram: '00' };

export function input(rip = CODE, registers: Record<number, bigint> = {}, flags = 0x8d7n) {
  return initial(rip, { 3: 0x1122334400000003n, ...registers }, flags);
}

export function noFault(result: RunResult) {
  equal(result.fault, undefined, 'unexpected access fault metadata');
}
