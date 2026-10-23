import net from 'node:net';
import type { Readable } from 'node:stream';

export interface ScanResult {
  clean: boolean;
  /** virus name reported by the engine (never file content) */
  signature?: string;
}

/** §5.3 / §7 stage 1: every upload is scanned before anyone can download or process it. */
export interface VirusScanner {
  readonly name: string;
  scan(input: Readable): Promise<ScanResult>;
}

/**
 * The EICAR anti-virus test string, assembled at runtime so this source file is not itself
 * flagged by a scanner on the developer's machine.
 */
export const EICAR = [
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$',
  'EICAR-STANDARD-ANTIVIRUS',
  '-TEST-FILE!$H+H*',
].join('');

/**
 * Dev/test scanner: reports the EICAR test file as infected, everything else as clean. Never
 * allowed in production (env validation requires CLAMAV_HOST there).
 */
export class MockVirusScanner implements VirusScanner {
  readonly name = 'mock';

  async scan(input: Readable): Promise<ScanResult> {
    const needle = Buffer.from(EICAR, 'latin1');
    let tail = Buffer.alloc(0);
    let found = false;
    for await (const chunk of input) {
      if (found) continue; // drain the stream
      const buf = Buffer.concat([tail, chunk as Buffer]);
      if (buf.includes(needle)) found = true;
      tail = buf.subarray(Math.max(0, buf.length - needle.length + 1));
    }
    return found ? { clean: false, signature: 'Eicar-Test-Signature' } : { clean: true };
  }
}

/**
 * ClamAV over the clamd TCP protocol (`zINSTREAM`): length-prefixed chunks, a zero-length
 * terminator, then a single reply such as `stream: OK` or `stream: Eicar-Signature FOUND`.
 * The compose `scan` profile runs clamd on 127.0.0.1:3310.
 */
export class ClamdScanner implements VirusScanner {
  readonly name = 'clamd';

  constructor(
    private readonly host: string,
    private readonly port = 3310,
    private readonly timeoutMs = 120_000,
  ) {}

  scan(input: Readable): Promise<ScanResult> {
    return new Promise<ScanResult>((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      let reply = '';
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        input.destroy();
        socket.destroy();
        reject(err);
      };
      socket.setTimeout(this.timeoutMs, () => fail(new Error('clamd timed out')));
      socket.on('error', (err) => fail(new Error(`clamd unavailable: ${err.message}`)));
      socket.on('data', (d) => {
        reply += d.toString('utf8');
      });
      socket.on('end', () => {
        if (settled) return;
        settled = true;
        socket.destroy();
        const text = reply.replace(/\0/g, '').trim();
        if (/: OK$/.test(text)) return resolve({ clean: true });
        const found = /: (.+) FOUND$/.exec(text);
        if (found) return resolve({ clean: false, signature: found[1] });
        // e.g. "INSTREAM size limit exceeded. ERROR": fail closed, the file stays pending/error
        reject(new Error(`clamd error: ${text.slice(0, 200)}`));
      });
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        input.on('data', (chunk: Buffer) => {
          const len = Buffer.alloc(4);
          len.writeUInt32BE(chunk.length);
          if (!socket.write(Buffer.concat([len, chunk]))) {
            input.pause();
            socket.once('drain', () => input.resume());
          }
        });
        input.on('end', () => socket.write(Buffer.alloc(4)));
        input.on('error', (err) => fail(err));
      });
    });
  }
}

export function createScanner(env: { CLAMAV_HOST?: string; CLAMAV_PORT: number }): VirusScanner {
  return env.CLAMAV_HOST
    ? new ClamdScanner(env.CLAMAV_HOST, env.CLAMAV_PORT)
    : new MockVirusScanner();
}
