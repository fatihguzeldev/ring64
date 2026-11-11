export type IoWidth = 8 | 16 | 32;
export interface IoProvider {
  read(port: number, width: IoWidth): number;
  write(port: number, width: IoWidth, value: number): void;
}
export interface IoBinding {
  receiver: IoProvider;
  read: IoProvider['read'];
  write: IoProvider['write'];
}

export function captureIo(options: { io?: IoProvider }): IoBinding | undefined {
  if (!('io' in options)) return undefined;
  const receiver = options.io;
  if (typeof receiver !== 'object' || receiver === null || Array.isArray(receiver))
    throw new TypeError('io must be a synchronous provider object');
  const read = receiver.read;
  const write = receiver.write;
  if (typeof read !== 'function' || typeof write !== 'function')
    throw new TypeError('io requires read and write methods');
  return { receiver, read, write };
}

export class IoBridge {
  executing = false;
  effectActive: (() => number) | undefined;
  constructor(private binding: IoBinding | undefined) {}
  get present(): boolean {
    return this.binding !== undefined;
  }
  private admitted(port: number, width: number): IoBinding {
    if (!this.executing || this.effectActive?.() !== 1 || !this.binding)
      throw new Error('port provider called outside a reached I/O effect');
    if (!Number.isInteger(port) || port < 0 || port > 0xffff || ![8, 16, 32].includes(width))
      throw new Error('invalid port transaction');
    return this.binding;
  }
  readonly imports = {
    read: (port: number, width: number): number => {
      const binding = this.admitted(port, width);
      const value = binding.read.call(binding.receiver, port, width as IoWidth);
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= 2 ** width)
        throw new TypeError('io.read must return an unsigned integer fitting its width');
      return value;
    },
    write: (port: number, width: number, value: number): void => {
      const binding = this.admitted(port, width);
      const unsigned = (value >>> 0) % 2 ** width;
      if (binding.write.call(binding.receiver, port, width as IoWidth, unsigned) !== undefined)
        throw new TypeError('io.write must return undefined');
    },
  };
  release(): void {
    this.executing = false;
    this.binding = undefined;
    this.effectActive = undefined;
  }
}
