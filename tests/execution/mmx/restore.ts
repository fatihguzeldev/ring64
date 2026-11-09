import {
  LONG,
  context,
  using,
  input,
  changed,
  outcome,
  stack,
  clone,
  seed,
  other,
  x87,
  banks,
  xmm,
  equal,
  bytes,
  hex,
  memory,
  fault,
  pending,
  noFault,
  ONE,
  type Scenario,
} from '../x87/fixture.js';

const PHYSICAL = [
  0n,
  ONE,
  0x7fff8000000000000022n,
  0x3fff0000000000000001n,
  0x80000000000000000000n,
  0x40008000000000000000n,
  1n,
  0x12340000000000000007n,
];
const LOGICAL_TOP5 = [5, 6, 7, 0, 1, 2, 3, 4].map((i) => bytes(PHYSICAL[i]!, 10)).join('');

export function restoreScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'literal FLDENV and FRSTOR distinguish all four legacy formats tags and loaded TOP placement',
      async run() {
        const formats = [
          {
            execution: LONG,
            prefix: '66',
            modrm: '23',
            image: '7f0200a818e7efcdffff1032ffff',
            ip: 0xcdefn,
            dp: 0x3210n,
            fop: 0x345,
          },
          {
            execution: LONG,
            prefix: '',
            modrm: '23',
            image: '7f02a5a500a8a5a518e7a5a5efcdab89adde56f410325476efbea5a5',
            ip: 0x89abcdefn,
            dp: 0x76543210n,
            fop: 0x456,
          },
          {
            execution: context('real', false, false),
            prefix: '',
            modrm: '27',
            image: '7f0200a818e7efcd56b410320040',
            ip: 0xbcdefn,
            dp: 0x43210n,
            fop: 0x456,
          },
          {
            execution: context('real', true, false),
            prefix: '',
            modrm: '23',
            image: '7f02a5a500a8a5a518e7a5a5efcda5a556b49a081032a5a500406507',
            ip: 0x89abcdefn,
            dp: 0x76543210n,
            fop: 0x456,
          },
        ];
        for (const format of formats) {
          for (const full of [false, true]) {
            const image = format.image + (full ? LOGICAL_TOP5 : '');
            const code = format.prefix + (full ? 'dd' : 'd9') + format.modrm;
            await using(
              compiler,
              code,
              format.execution,
              async (cpu) => {
                const before = input(0x1000n, { 3: 0x6000n }, 0xcd7n),
                  numeric = stack({}, 3);
                if (!full) numeric.registers = PHYSICAL.slice();
                cpu.setState(before);
                seed(cpu, numeric);
                const result = await cpu.run({ budget: 1n, repeatBudget: 13n });
                outcome(
                  result,
                  'budget',
                  1n,
                  1n,
                  13n,
                  0n,
                  changed(before, 0x1000n + BigInt(code.length / 2)),
                );
                const expected = clone(numeric);
                expected.registers = PHYSICAL.slice();
                expected.controlWord = 0x27f;
                expected.statusWord = 0x2800;
                expected.tagWord = 0xe3a1;
                expected.instructionPointer = format.ip;
                expected.dataPointer = format.dp;
                expected.opcode = format.fop;
                x87(cpu, expected);
                other(cpu);
                noFault(result);
                memory(cpu, 0x6000n, image);
              },
              { data: [{ base: 0x6000n, bytes: image, write: false }] },
            );
          }
        }
      },
    },
    {
      name: 'legacy environment restores check old pending x87 before source access and retry retained code after repair',
      async run() {
        for (const [code, width] of [
          ['d923', 28],
          ['dd23', 108],
        ] as const) {
          await using(compiler, code, LONG, async (cpu) => {
            const before = input(0x1000n, { 3: 0x6000n }, 0xcd7n),
              numeric = stack({ 0: ONE }, 5, 0x37b, 0x8084);
            cpu.setState(before);
            seed(cpu, numeric);
            const blocked = await cpu.run({ budget: 1n, repeatBudget: 13n });
            outcome(blocked, 'x87-exception', 1n, 0n, 13n, 0n, before);
            pending(blocked, numeric, 0x1000n);
            x87(cpu, numeric);
            other(cpu);
            const repaired = clone(numeric);
            repaired.controlWord |= 0x3f;
            repaired.statusWord &= ~0x8080;
            cpu.setX87State(repaired);
            const accessed = await cpu.run({ budget: 1n, repeatBudget: 13n });
            outcome(accessed, 'data-fault', 1n, 0n, 13n, 0n, before);
            fault(accessed, {
              instructionPc: 0x1000n,
              address: 0x6000n,
              width,
              access: 'read',
              cause: 'unmapped',
              failingAddress: 0x6000n,
              segment: 'ds',
            });
            equal(
              accessed.x87Exception,
              undefined,
              'source fault replaces transient pending record',
            );
            x87(cpu, repaired);
            other(cpu);
            equal(accessed.resources.compilations, 0, 'numeric repair keeps retained restore code');
          });
        }
      },
    },
    {
      name: 'retained FXRSTOR observes changed image data without recompilation and defers newly loaded pending state to WAIT',
      async run() {
        const image = new Uint8Array(512).fill(0xa5);
        image.set(hex('7f03000000a5450344443333222211118888777766665555801f000000000000'));
        const vector = banks();
        vector[0] = 1n;
        for (let i = 0; i < 8; i++) image.set(hex(bytes(PHYSICAL[i]!, 10)), 32 + 16 * i);
        for (let i = 0; i < 16; i++) image.set(hex(bytes(vector[i]!, 16)), 160 + 16 * i);
        await using(
          compiler,
          '480fae0b909b',
          LONG,
          async (cpu) => {
            const before = input(0x1000n, { 3: 0x6000n }, 0xcd7n),
              original = stack({}, 3);
            cpu.setState(before);
            seed(cpu, original);
            const first = await cpu.run({ budget: 1n, repeatBudget: 13n });
            outcome(first, 'budget', 1n, 1n, 13n, 0n, changed(before, 0x1004n));
            const loaded = stack();
            loaded.registers = PHYSICAL.slice();
            loaded.instructionPointer = 0x1111222233334444n;
            loaded.dataPointer = 0x5555666677778888n;
            x87(cpu, loaded);
            xmm(cpu, vector);
            equal(cpu.readMxcsr(), 0x1f80, 'first image controls');
            noFault(first);
            const owner = cpu.inspectTranslations()[0]!;
            equal(cpu.inspectTranslations().length, 1, 'one retained image owner');
            cpu.writeMemory(0x6000n, hex('7b030400'));
            cpu.writeMemory(0x6018n, hex('c5ff0000'));
            cpu.writeMemory(0x60a0n, hex(bytes(2n, 16)));
            cpu.setState(before);
            const afterWrite = cpu.inspectTranslations()[0]!;
            equal(afterWrite.owner, owner.owner, 'ordinary image data does not invalidate code');
            equal(
              afterWrite.contextVersion,
              owner.contextVersion,
              'data write preserves context version',
            );
            const second = await cpu.run({ budget: 2n, repeatBudget: 13n });
            outcome(second, 'budget', 2n, 2n, 13n, 0n, changed(before, 0x1005n));
            equal(second.resources.compilations, 0, 'changed restore source is invocation data');
            equal(
              second.resources.nativeEntries,
              1,
              'restore and GP successor stay in one invocation',
            );
            equal(second.resources.dispatches, 0, 'restore does not signal code write');
            noFault(second);
            vector[0] = 2n;
            xmm(cpu, vector);
            loaded.controlWord = 0x37b;
            loaded.statusWord = 0x8084;
            x87(cpu, loaded);
            equal(cpu.readMxcsr(), 0xffc5, 'changed image controls');
            const retained = cpu.inspectTranslations()[0]!;
            equal(retained.owner, owner.owner, 'restore preserves code owner');
            equal(
              retained.contextVersion,
              owner.contextVersion,
              'restore preserves context version',
            );
            const execution = cpu.readContext();
            equal(execution.mode, 'long64', 'restore preserves execution mode');
            if (execution.mode !== 'long64') throw new Error('restore changed execution mode');
            equal(execution.segments.fs.base, 0n, 'restore preserves FS base');
            equal(execution.segments.gs.base, 0n, 'restore preserves GS base');
            const waiting = await cpu.run({ budget: 1n, repeatBudget: 13n });
            outcome(waiting, 'x87-exception', 1n, 0n, 13n, 0n, changed(before, 0x1005n));
            pending(waiting, loaded, 0x1005n);
            x87(cpu, loaded);
            xmm(cpu, vector);
            equal(cpu.readMxcsr(), 0xffc5, 'checking WAIT preserves restored MXCSR');
            equal(waiting.resources.compilations, 0, 'checking WAIT uses retained code');
          },
          {
            data: [
              {
                base: 0x6000n,
                bytes: Array.from(image, (b) => b.toString(16).padStart(2, '0')).join(''),
              },
            ],
          },
        );
      },
    },
  ];
}
