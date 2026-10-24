import net from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { ClamdScanner, EICAR, MockVirusScanner, createScanner } from './scanner';

/** Minimal clamd stand-in: parses zINSTREAM framing and answers like clamd does. */
function fakeClamd(reply: (data: Buffer) => string | null) {
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const cmd = 'zINSTREAM\0';
      if (buf.length < cmd.length) return;
      let offset = cmd.length;
      const chunks: Buffer[] = [];
      for (;;) {
        if (buf.length < offset + 4) return;
        const len = buf.readUInt32BE(offset);
        if (len === 0) break;
        if (buf.length < offset + 4 + len) return;
        chunks.push(buf.subarray(offset + 4, offset + 4 + len));
        offset += 4 + len;
      }
      const answer = reply(Buffer.concat(chunks));
      if (answer === null) return socket.destroy();
      socket.end(`${answer}\0`);
    });
  });
  return new Promise<{ port: number; close: () => void }>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as net.AddressInfo).port,
        close: () => server.close(),
      }),
    ),
  );
}

let close: (() => void) | undefined;
afterEach(() => close?.());

const chunks = (...parts: string[]) => Readable.from(parts.map((p) => Buffer.from(p, 'latin1')));

describe('MockVirusScanner', () => {
  it('flags EICAR even when it spans chunk boundaries', async () => {
    const s = new MockVirusScanner();
    expect(await s.scan(chunks('%PDF-1.4 clean content'))).toEqual({ clean: true });
    const mid = 20;
    expect(await s.scan(chunks('junk', EICAR.slice(0, mid), EICAR.slice(mid), 'tail'))).toEqual({
      clean: false,
      signature: 'Eicar-Test-Signature',
    });
  });
});

describe('ClamdScanner (zINSTREAM)', () => {
  it('streams the file and reports clean / FOUND', async () => {
    const srv = await fakeClamd((data) =>
      data.includes(Buffer.from(EICAR)) ? 'stream: Eicar-Signature FOUND' : 'stream: OK',
    );
    close = srv.close;
    const s = new ClamdScanner('127.0.0.1', srv.port);
    expect(await s.scan(chunks('hello ', 'world'))).toEqual({ clean: true });
    expect(await s.scan(chunks('a', EICAR, 'b'))).toEqual({
      clean: false,
      signature: 'Eicar-Signature',
    });
  });

  it('fails closed on clamd errors, dropped connections and no server', async () => {
    const srv = await fakeClamd(() => 'INSTREAM size limit exceeded. ERROR');
    close = srv.close;
    await expect(new ClamdScanner('127.0.0.1', srv.port).scan(chunks('x'))).rejects.toThrow(
      /clamd error/,
    );
    close();
    const dropper = await fakeClamd(() => null);
    close = dropper.close;
    await expect(new ClamdScanner('127.0.0.1', dropper.port).scan(chunks('x'))).rejects.toThrow(
      /clamd/,
    );
    close();
    close = undefined;
    await expect(new ClamdScanner('127.0.0.1', dropper.port).scan(chunks('x'))).rejects.toThrow(
      /clamd unavailable/,
    );
  });

  it('createScanner uses clamd only when CLAMAV_HOST is set', () => {
    expect(createScanner({ CLAMAV_PORT: 3310 }).name).toBe('mock');
    expect(createScanner({ CLAMAV_HOST: 'clamav', CLAMAV_PORT: 3310 }).name).toBe('clamd');
  });
});
