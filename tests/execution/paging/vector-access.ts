import {
  BANK,
  PC,
  usingPaged,
  word,
  equal,
  same,
  hex,
  initial,
  check,
  type Scenario,
} from './fixture.js';

export function pagingVectorAccessScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'paging access MOVDQU preserves complete vectors and payloads across a nonadjacent page failure and repaired admission',
      async run() {
        for (const store of [false, true])
          for (const missing of [false, true]) {
            const first = new Uint8Array(0x1000).fill(0xa5),
              second = new Uint8Array(0x1000).fill(0xa5);
            if (!store) {
              first.set(hex('1011121314151617'), 0xff8);
              second.set(hex('18191a1b1c1d1e1f'));
            }
            await usingPaged(
              compiler,
              {
                code: store ? 'f30f7f07' : 'f30f6f07',
                words: [
                  [0x4800n, 0xa007n],
                  [0x4808n, missing ? 0n : 0xc007n],
                ],
                spans: [
                  { physical: 0xa000n, bytes: first },
                  { physical: 0xc000n, bytes: second },
                ],
              },
              async (cpu) => {
                cpu.setState(initial(PC, { 7: 0x500ff8n }, 0x8d7n));
                const vectors = Array<bigint>(16).fill(0xdeadbeefn);
                if (store) vectors[0] = 0x1f1e1d1c1b1a19181716151413121110n;
                cpu.setXmmState(vectors);
                const result = await cpu.run({ budget: 1n });
                equal(result.reason, missing ? 'page-fault' : 'budget', 'vector admission outcome');
                equal(result.retired, missing ? 0n : 1n, 'whole instruction retirement');
                equal(result.state.flags, 0x8d7n, 'vector flags unchanged');
                same(
                  cpu.readXmmState(),
                  vectors.map((v, i) =>
                    !store && !missing && i === 0 ? 0x1f1e1d1c1b1a19181716151413121110n : v,
                  ),
                  'all vector banks',
                );
                if (store && !missing) {
                  same(
                    cpu.readPhysicalMemory(0xaff8n, 8),
                    hex('1011121314151617'),
                    'first stored fragment',
                  );
                  same(
                    cpu.readPhysicalMemory(0xc000n, 8),
                    hex('18191a1b1c1d1e1f'),
                    'second stored fragment',
                  );
                } else {
                  same(cpu.readPhysicalMemory(0xa000n, 0x1000), first, 'first page unchanged');
                  same(cpu.readPhysicalMemory(0xc000n, 0x1000), second, 'second page unchanged');
                }
                equal(
                  word(cpu, 0x4800n),
                  store && !missing ? 0xa067n : 0xa027n,
                  'first page actual dirty',
                );
                equal(
                  word(cpu, 0x4808n),
                  missing ? 0n : store ? 0xc067n : 0xc027n,
                  'second page actual dirty',
                );
                if (missing) {
                  equal(cpu.readPagingState().cr2, 0x501000n, 'second fragment fault byte');
                  cpu.writePhysicalMemory(0x4808n, hex('07c0000000000000'));
                  const retry = await cpu.run({ budget: 1n });
                  equal(retry.reason, 'budget', 'repaired complete vector');
                  equal(retry.retired, 1n, 'no partial vector retirement');
                }
              },
            );
          }
      },
    },
    {
      name: 'paging access mandatory vector alignment wins before absent data walks and invalid MXCSR is checked after successful operand admission',
      async run() {
        await usingPaged(
          compiler,
          { code: '660f6f07', bank: { ...BANK, cr2: 0x1234n } },
          async (cpu) => {
            cpu.setState(initial(PC, { 7: 0x500ff8n }, 2n));
            const numeric = cpu.readXmmState();
            const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
            equal(result.reason, 'event-budget', 'alignment selects GP source');
            equal(result.retired, 0n, 'no vector retirement');
            check(result.state.event.kind === 'pending', 'GP retained');
            equal(result.state.event.exception.vector, 13, 'alignment GP');
            equal(result.state.event.exception.errorCode, 0, 'hard zero');
            equal(cpu.readPagingState().cr2, 0x1234n, 'no operand PF publication');
            equal(word(cpu, 0x4800n), 0n, 'no data page walk');
            same(cpu.readXmmState(), numeric, 'vector bank unchanged');
          },
        );
        await usingPaged(
          compiler,
          {
            code: '0fae17',
            words: [[0x4800n, 0xa007n]],
            spans: [{ physical: 0xa000n, bytes: hex('00000100') }],
          },
          async (cpu) => {
            cpu.setState(initial(PC, { 7: 0x500000n }, 2n));
            cpu.setMxcsr(0x1f80);
            const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
            equal(result.reason, 'event-budget', 'reserved MXCSR content GP');
            equal(result.retired, 0n, 'load does not complete');
            check(result.state.event.kind === 'pending', 'GP source retained');
            equal(result.state.event.exception.vector, 13, 'content GP follows read');
            equal(cpu.readMxcsr(), 0x1f80, 'no partial numeric bank');
            equal(word(cpu, 0x4800n), 0xa027n, 'successful operand walk retains A without D');
            equal(cpu.readPagingState().cr2, 0n, 'no false PF for content');
          },
        );
      },
    },
  ];
}
