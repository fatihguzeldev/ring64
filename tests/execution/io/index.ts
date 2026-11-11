import { ioBoundaryScenarios } from './boundaries.js';
import { stringIoScenarios } from './strings.js';
import { createCpu } from '../../../host/index.js';
import { LIMITS, equal, hex, initial, type Scenario } from '../../support/fixture.js';

export function ioScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...stringIoScenarios(compiler),
    ...ioBoundaryScenarios(compiler),
    {
      name: 'scalar port transfers preserve widths and publish unsigned dword values',
      async run() {
        const trace: string[] = [];
        const cpu = await createCpu(
          Object.assign(
            {
              compiler,
              limits: LIMITS,
              code: { base: 0x1000n, bytes: hex('66ede5ffefe6fe') },
              ram: { base: 0x4000n, bytes: new Uint8Array(8) },
            },
            {
              io: {
                read(port: number, width: number) {
                  trace.push(`in:${port}:${width}`);
                  return width === 16 ? 0xabcd : 0xfedcba98;
                },
                write(port: number, width: number, value: number) {
                  trace.push(`out:${port}:${width}:${value}`);
                },
              },
            },
          ),
        );
        try {
          cpu.setState(initial(0x1000n, { 0: 0x1122334455667788n, 2: 0x8000000000001234n }));
          const result = await cpu.run({ budget: 4n, repeatBudget: 0n });
          equal(result.reason, 'budget', 'scalar I/O exit');
          equal(result.retired, 4n, 'scalar I/O retirement');
          equal(result.state.rip, 0x1007n, 'exact scalar byte length');
          equal(result.state.registers[0], 0xfedcba98n, 'EAX input zero extension');
          equal(result.repeatIterations, 0n, 'scalar I/O repeat work');
          equal(
            trace.join(','),
            'in:4660:16,in:255:32,out:4660:32:4275878552,out:254:8:152',
            'unsigned full-width transactions',
          );
        } finally {
          cpu.dispose();
        }
      },
    },
  ];
}
