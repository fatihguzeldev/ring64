import {
  changed,
  check,
  codePair,
  equal,
  gate,
  hex,
  image,
  initial,
  linear,
  little,
  longSnapshot,
  noCompilation,
  preserveNumeric,
  protectedSnapshot,
  same,
  tssDescriptor,
  type Factory,
  type Scenario,
} from './fixture.js';
import { fastSetup, FAST_FORMS, USER } from './warm.js';

const CODE32 = 'ffff0000009bcf00',
  CODE64 = 'ffff0000009baf00';
export function eventSetup(source = '90', handler = 'cf') {
  const execution = protectedSnapshot(),
    ram = new Uint8Array(0x5000).fill(0xa5);
  execution.gdtr = { base: 0x4000n, limit: 0x1f };
  execution.idtr = { base: 0x8000n, limit: 0x7ff };
  ram.set(hex(CODE32), 8);
  ram.set(hex(CODE32), 0x18);
  for (const vector of [2, 6, 0x20, 0x30])
    ram.set(hex(gate(32, 0x18, 0x2000n, 0)), 0x4000 + vector * 8);
  return { execution, ram, code: codePair(source, handler) };
}

export function writerScenarios(compiler: WebAssembly.Module, make: Factory): Scenario[] {
  return [
    {
      name: 'context reuse warms protected INT IRET and LOOP middle entries for101complete cycles under quota1',
      async run() {
        const setup = eventSetup('cd30e2fc');
        await linear(
          compiler,
          make,
          setup.code,
          setup.execution,
          async (cpu) => {
            const input = (count: bigint) => initial(0x1000n, { 1: count, 4: 0x7000n }, 0x202n),
              numeric = preserveNumeric(cpu);
            cpu.setState(input(1n));
            for (let i = 0; i < 3; i++)
              equal(
                (await cpu.run({ budget: 1n })).reason,
                'budget',
                'finite INT IRET LOOP priming',
              );
            const before = input(101n);
            cpu.setState(before);
            await noCompilation(async () => {
              const result = await cpu.run({ budget: 303n });
              equal(result.reason, 'budget', 'all101 software entry/return cycles complete');
              equal(result.retired, 303n, 'literal INT IRET LOOP work');
              equal(result.resources.compilations, 0, 'source return and LOOP entries all warm');
              same(
                result.state,
                changed(before, 0x1004n, { 1: 0n }),
                'literal full returned software-loop scalar result',
              );
            });
            same(
              cpu.readMemory(0x6ff4n, 12),
              image([0x1002n, 8n, 0x202n], 4),
              'last literal protected software frame',
            );
            same(
              cpu.readContext(),
              setup.execution,
              'full protected facts return after every cycle',
            );
            numeric();
          },
          { bytes: setup.ram, limits: { maxTranslationsPerRun: 1 } },
        );
      },
    },
    {
      name: 'context reuse faulting warmed IRET keeps its old context while performing early NMI unblock',
      async run() {
        const setup = eventSetup('cf'),
          a = setup.execution,
          b = { ...a, segments: { ...a.segments, fs: { ...a.segments.fs, base: 0x5000n } } };
        setup.ram.set(image([0x1000n, 8n, 0x202n], 4), 0x3000);
        await linear(
          compiler,
          make,
          setup.code,
          a,
          async (cpu) => {
            const numeric = preserveNumeric(cpu),
              input = initial(0x1000n, { 4: 0x7000n }, 0x202n);
            for (const context of [a, b]) {
              cpu.setContext(context);
              cpu.setState(input);
              equal(
                (await cpu.run({ budget: 1n })).reason,
                'budget',
                'valid IRET primes each context',
              );
            }
            cpu.setContext(a);
            cpu.writeMemory(0x7004n, little(0x28n, 4));
            const before = {
              ...input,
              interrupts: { irq: null, nmiPending: false, nmiBlocked: true },
            };
            cpu.setState(before);
            await noCompilation(async () => {
              const result = await cpu.run({ budget: 1n });
              equal(result.reason, 'protection-fault', 'out-of-table return selector');
              equal(result.protectionFault?.errorCode, 0x28, 'literal bad return selector');
              equal(result.retired, 0n, 'failed IRET has no retirement');
              equal(result.resources.compilations, 0, 'failure executes already retained A');
              same(result.state, input, 'only early NMI unblock changes the imported state');
              same(cpu.readContext(), a, 'failed writer does not publish destination facts');
            });
            numeric();
          },
          { bytes: setup.ram },
        );
      },
    },
    {
      name: 'context reuse performs MOV FS publication before a warmed successor and retains the source context',
      async run() {
        const a = longSnapshot(0x4000n),
          ram = new Uint8Array(0x3000).fill(0xa5);
        a.segments.fs.selector = 0x20;
        a.gdtr = { base: 0x6000n, limit: 0x2f };
        ram.set(little(0x1111222233330020n), 0);
        ram.set(little(0x5555666677778888n), 0x1000);
        ram.set(hex('ffff00500092cf00'), 0x2020);
        const b = { ...a, segments: { ...a.segments, fs: { ...a.segments.fs, base: 0x5000n } } };
        await linear(
          compiler,
          make,
          '64488b038ee064488b0382',
          a,
          async (cpu) => {
            const numeric = preserveNumeric(cpu),
              input = initial(0x1000n, { 3: 0n });
            cpu.setState(input);
            const first = await cpu.run({ budget: 3n });
            same(
              first.state,
              changed(input, 0x100an, { 0: 0x5555666677778888n }),
              'first source writer and consumer',
            );
            same(cpu.readContext(), b, 'literal new loaded FS cache');
            equal(
              cpu.readMemory(0x6025n, 1)[0],
              0x93,
              'first real segment reload publishes accessed bit',
            );
            cpu.setContext(a);
            cpu.writeMemory(0x6025n, Uint8Array.of(0x92));
            cpu.setState(input);
            await noCompilation(async () => {
              const warm = await cpu.run({ budget: 3n });
              equal(warm.resources.compilations, 0, 'both loaded-base contexts retained');
              same(warm.state, first.state, 'fresh FS reload still executes before consumer');
            });
            const expectedRam = ram.slice();
            expectedRam[0x2025] = 0x93;
            same(
              cpu.readMemory(0x4000n, ram.length),
              expectedRam,
              'cache hit repeats accessed-bit write and preserves every guard',
            );
            numeric();
          },
          { bytes: ram },
        );
      },
    },
    ...(['gdtr', 'idtr', 'ldtr', 'tr'] as const).map((table): Scenario => ({
      name: `context reuse retains an owner across guest ${table} publication without skipping its memory effects`,
      async run() {
        const a = longSnapshot(),
          ram = new Uint8Array(0x4000).fill(0xa5);
        a.gdtr = { base: 0x4000n, limit: 0x3f };
        const system = table === 'ldtr' || table === 'tr';
        if (system)
          ram.set(hex(tssDescriptor(0x5000n, 0x67, table === 'ldtr' ? 2 : 9, true)), 0x28);
        else {
          ram.set(little(0x3fn, 2), 0x2000);
          ram.set(little(0x7000n), 0x2002);
        }
        const code =
          table === 'gdtr'
            ? '0f0113'
            : table === 'idtr'
              ? '0f011b'
              : table === 'ldtr'
                ? '0f00d0'
                : '0f00d8';
        await linear(
          compiler,
          make,
          code + '82',
          a,
          async (cpu) => {
            const numeric = preserveNumeric(cpu),
              input = initial(0x1000n, { 0: 0x28n, 3: 0x6000n });
            const expected = system
              ? {
                  selector: 0x28,
                  valid: true,
                  base: 0x5000n,
                  limit: 0x67,
                  attributes: table === 'ldtr' ? 0x82 : 0x8b,
                }
              : { base: 0x7000n, limit: 0x3f };
            cpu.setState(input);
            const first = await cpu.run({ budget: 1n });
            equal(first.reason, 'budget', 'first system publication');
            same(cpu.readContext(), { ...a, [table]: expected }, 'complete first system cache');
            check(
              cpu.inspectTranslations().length > 0,
              'changed system state does not kill the source owner',
            );
            cpu.setContext(a);
            if (table === 'tr') cpu.writeMemory(0x402dn, Uint8Array.of(0x89));
            if (!system) cpu.writeMemory(0x6002n, little(0x7100n));
            cpu.setState(input);
            await noCompilation(async () => {
              const result = await cpu.run({ budget: 1n });
              equal(result.reason, 'budget', 'warm system operation still executes');
              equal(result.resources.compilations, 0, 'original system context reused');
              same(result.state, changed(input, 0x1003n), 'no system GPR or flags clobber');
            });
            same(
              cpu.readContext(),
              { ...a, [table]: system ? expected : { base: 0x7100n, limit: 0x3f } },
              'new operand consumed on a cache hit',
            );
            if (table === 'tr')
              equal(cpu.readMemory(0x402dn, 1)[0], 0x8b, 'actual busy publication repeats');
            numeric();
          },
          { bytes: ram },
        );
      },
    })),
    ...(['fs', 'gs'] as const).map((segment): Scenario => ({
      name: `context reuse guest ${segment.toUpperCase()}_BASE WRMSR ends the old native path before the cached new-base consumer`,
      async run() {
        const setup = fastSetup(compiler, FAST_FORMS[0]);
        setup.ram.set(hex(`0f30${segment === 'fs' ? '64' : '65'}488b0382`), 0x9000);
        setup.ram.set(little(0x1111222233334444n), 0xc000);
        setup.ram.set(little(0x5555666677778888n), 0xe000);
        const a = {
          ...setup.kernel,
          segments: {
            ...setup.kernel.segments,
            [segment]: { ...setup.kernel.segments[segment], base: 0x403000n },
          },
        };
        const b = {
          ...a,
          segments: { ...a.segments, [segment]: { ...a.segments[segment], base: 0x405000n } },
        };
        const cpu = await make({ ...setup.options, context: a });
        try {
          const numeric = preserveNumeric(cpu);
          for (const execution of [a, b]) {
            cpu.setContext(execution);
            cpu.setState(initial(USER + 2n, { 3: 0n }));
            const result = await cpu.run({ budget: 1n });
            equal(
              result.state.registers[0],
              execution === a ? 0x1111222233334444n : 0x5555666677778888n,
              'independent successor load',
            );
          }
          const input = initial(USER, {
            0: 0x405000n,
            1: segment === 'fs' ? 0xc0000100n : 0xc0000101n,
            2: 0n,
            3: 0n,
          });
          cpu.setContext(a);
          cpu.setState(input);
          await cpu.run({ budget: 2n });
          cpu.setContext(a);
          cpu.setState(input);
          await noCompilation(async () => {
            const result = await cpu.run({ budget: 2n });
            equal(result.resources.compilations, 0, 'source and new successor owners retained');
            same(
              result.state,
              changed(input, USER + 6n, { 0: 0x5555666677778888n }),
              'live WRMSR operand then new loaded-base value',
            );
          });
          same(cpu.readContext(), b, 'single loaded-base authority');
          numeric();
        } finally {
          cpu.dispose();
        }
      },
    })),
    {
      name: 'context reuse warms ordinary far JMP contexts and complete middle entries for101cycles',
      async run() {
        const a = longSnapshot(),
          ram = new Uint8Array(0x3000).fill(0xa5);
        a.gdtr = { base: 0x4000n, limit: 0x1f };
        ram.set(hex(CODE64), 8);
        ram.set(hex(CODE64), 0x18);
        ram.set(little(0x2000n), 0x2000);
        ram.set(little(0x18n, 2), 0x2008);
        ram.set(little(0x1000n), 0x2010);
        ram.set(little(8n, 2), 0x2018);
        await linear(
          compiler,
          make,
          codePair('48bb006000000000000048ff2b', '48bb106000000000000048ff2b'),
          a,
          async (cpu) => {
            const numeric = preserveNumeric(cpu),
              input = initial(0x1000n);
            cpu.setState(input);
            for (let i = 0; i < 4; i++)
              equal((await cpu.run({ budget: 1n })).reason, 'budget', 'finite far priming');
            cpu.setState(input);
            await noCompilation(async () => {
              const result = await cpu.run({ budget: 404n });
              equal(result.reason, 'budget', '101 far cycles under quota1');
              equal(result.retired, 404n, 'two MOVs and two real far JMPs per cycle');
              equal(result.resources.compilations, 0, 'far variants and middle entries stay warm');
              same(
                result.state,
                changed(input, 0x1000n, { 3: 0x6010n }),
                'literal full far loop result',
              );
            });
            same(cpu.readContext(), a, 'literal original CS cache restored');
            same(cpu.readMemory(0x4000n, ram.length), ram, 'descriptors and far pointers guarded');
            numeric();
          },
          { bytes: ram, limits: { maxTranslationsPerRun: 1 } },
        );
      },
    },
    {
      name: 'context reuse retains software INT and IRET contexts while rebuilding their literal frames',
      async run() {
        const setup = eventSetup('cd30');
        await linear(
          compiler,
          make,
          setup.code,
          setup.execution,
          async (cpu) => {
            const numeric = preserveNumeric(cpu),
              input = initial(0x1000n, { 4: 0x7000n }, 0x202n);
            cpu.setState(input);
            for (let i = 0; i < 2; i++)
              equal(
                (await cpu.run({ budget: 1n })).reason,
                'budget',
                'software entry/return priming',
              );
            cpu.setState(input);
            await noCompilation(async () => {
              const result = await cpu.run({ budget: 2n });
              equal(result.reason, 'budget', 'cached software entry and return');
              equal(result.resources.compilations, 0, 'source and handler contexts retained');
              same(result.state, changed(input, 0x1002n), 'literal returned scalar checkpoint');
            });
            same(
              cpu.readMemory(0x6ff4n, 12),
              image([0x1002n, 8n, 0x202n], 4),
              'new literal software frame',
            );
            same(cpu.readContext(), setup.execution, 'complete returned protected context');
            numeric();
          },
          { bytes: setup.ram, limits: { maxTranslationsPerRun: 1 } },
        );
      },
    },
    ...(['irq', 'nmi', 'fault'] as const).map((source): Scenario => ({
      name: `context reuse retains automatic ${source} handler contexts without retaining event history`,
      async run() {
        const setup = source === 'fault' ? eventSetup('0f0b', '83042402cf') : eventSetup();
        await linear(
          compiler,
          make,
          setup.code,
          setup.execution,
          async (cpu) => {
            const numeric = preserveNumeric(cpu),
              input = initial(0x1000n, { 4: 0x7000n }, 0x202n);
            const arm = () => {
              cpu.setState(input);
              if (source === 'irq') cpu.requestInterrupt(0x20);
              else if (source === 'nmi') cpu.requestNmi();
            };
            arm();
            const budget = source === 'fault' ? 2n : 1n;
            const first = await cpu.run({ budget, eventDelivery: { budget: 1n } });
            equal(first.reason, 'budget', 'initial automatic frame and handler');
            same(cpu.readContext(), setup.execution, 'first handler returns original caches');
            arm();
            await noCompilation(async () => {
              const result = await cpu.run({ budget, eventDelivery: { budget: 1n } });
              equal(result.reason, 'budget', 'warm automatic handler completes');
              equal(result.retired, budget, 'only handler instructions retire');
              equal(result.deliveryAttempts, 1n, 'exactly one fresh accepted source');
              equal(
                result.resources.compilations,
                0,
                'automatic entry and IRET retain handler owner',
              );
              same(
                result.state,
                changed(
                  input,
                  source === 'fault' ? 0x1002n : 0x1000n,
                  {},
                  source === 'fault' ? 0x10202n : 0x202n,
                ),
                'no stale event NMI blocking or scalar state restored',
              );
            });
            same(
              cpu.readMemory(0x6ff4n, 12),
              image(
                [
                  source === 'fault' ? 0x1002n : 0x1000n,
                  8n,
                  source === 'fault' ? 0x10202n : 0x202n,
                ],
                4,
              ),
              'fresh independent automatic frame bytes',
            );
            numeric();
          },
          { bytes: setup.ram },
        );
      },
    })),
  ];
}
