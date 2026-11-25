/**
 * Host side of a jailed agent's network (main/agentJail.ts): an HTTP proxy on a unix
 * socket, the jail's only way out. CONNECT and absolute-URI requests to hosts on the
 * allowlist are passed through; loopback only on the listed ports; anything else gets
 * a 403 and onDeny. The allowlist is read per request, so a card grant applies at once.
 */
import * as net from 'node:net';
import { unlinkSync } from 'node:fs';
import { hostAllowed } from './netAllow';
import { telemetryHost } from './agentJail';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const MAX_HEAD = 64 * 1024;

export interface JailProxyOptions {
  sock: string;
  allow: () => readonly string[];
  loopbackPorts: readonly number[];
  onDeny: (host: string) => void;
  /** Where to dial an allowed host; tests point it at a local server. */
  connectTo?: (host: string, port: number) => { host: string; port: number };
}

function splitHostPort(s: string, dflt: number): { host: string; port: number } | null {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(s) ?? /^([^:]+)(?::(\d+))?$/.exec(s);
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : dflt;
  return port > 0 && port < 65536 ? { host: m[1].toLowerCase(), port } : null;
}

export function startJailProxy(o: JailProxyOptions): Promise<{ close(): void }> {
  const permitted = (host: string, port: number): boolean => LOOPBACK.has(host)
    ? o.loopbackPorts.includes(port)
    : !telemetryHost(host) && hostAllowed(host, o.allow());

  const server = net.createServer((c) => {
    let head = Buffer.alloc(0);
    c.on('error', () => c.destroy());
    const onData = (d: Buffer): void => {
      head = Buffer.concat([head, d]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) { if (head.length > MAX_HEAD) c.destroy(); return; }
      c.removeListener('data', onData);
      c.pause();
      const text = head.subarray(0, end).toString('latin1');
      const rest = head.subarray(end + 4);
      const [line, ...headers] = text.split('\r\n');
      const [method, target, version] = line.split(' ');
      let dest: { host: string; port: number } | null = null;
      let firstOut: Buffer | null = null;
      if (method === 'CONNECT') {
        dest = splitHostPort(target ?? '', 443);
      } else {
        let u: URL | null = null;
        try { u = new URL(target ?? ''); } catch { u = null; }
        if (u && u.protocol === 'http:') {
          dest = { host: u.hostname.toLowerCase().replace(/^\[|\]$/g, ''), port: u.port ? Number(u.port) : 80 };
          const kept = headers.filter((h) => !/^proxy-/i.test(h));
          firstOut = Buffer.concat([Buffer.from(`${method} ${u.pathname}${u.search} ${version}\r\n${kept.join('\r\n')}\r\n\r\n`, 'latin1'), rest]);
        }
      }
      if (!dest) { c.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n'); return; }
      if (!permitted(dest.host, dest.port)) {
        try { o.onDeny(dest.host); } catch { /* reporting is best-effort */ }
        c.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${dest.host} is not on this agent's network allowlist\n`);
        return;
      }
      const to = o.connectTo ? o.connectTo(dest.host, dest.port) : dest;
      const up = net.createConnection(to.port, to.host);
      up.on('error', () => {
        if (!c.destroyed) c.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
      });
      up.on('connect', () => {
        if (method === 'CONNECT') {
          c.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (rest.length) up.write(rest);
        } else if (firstOut) up.write(firstOut);
        c.pipe(up); up.pipe(c);
        c.on('close', () => up.destroy());
        up.on('close', () => c.destroy());
        c.resume();
      });
    };
    c.on('data', onData);
  });

  try { unlinkSync(o.sock); } catch { /* none left over */ }
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.sock, () => resolve({ close: () => { server.close(); try { unlinkSync(o.sock); } catch { /* gone */ } } }));
  });
}
