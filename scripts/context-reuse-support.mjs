import { resolve } from 'node:path';
import { manifest } from './paging-support.mjs';

export const contextBaseline = '/tmp/ring64-context-baseline-c956';
export async function checkedContextBaseline(path = contextBaseline) {
  const result = await manifest(resolve(path));
  if (
    result.source.commit !== 'c956811ea40e94d6bf683f6e105839d1a383ffef' ||
    result.coreSha256 !== 'af835f3d514ee7abc6fa63db6545c6c1af6a87bd3e158151e996d70bb808d017' ||
    result.productionHostSha256 !==
      'c2efa3517c804f2b0e95ded18b874173d1d760ec841124e28678d24963c05f05'
  )
    throw Error('context reuse requires the preserved c956811 shipping baseline');
  return result;
}
