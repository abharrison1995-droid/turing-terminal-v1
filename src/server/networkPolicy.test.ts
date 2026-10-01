import { describe, expect, it } from 'vitest';
import { assertLoopbackHost } from './networkPolicy.js';

describe('network bind policy', () => {
  it.each(['127.0.0.1', 'localhost', '::1'])('allows the loopback host %s', (host) => {
    expect(() => assertLoopbackHost(host)).not.toThrow();
  });

  it.each(['0.0.0.0', '192.168.1.12', 'example.com'])('rejects non-loopback host %s', (host) => {
    expect(() => assertLoopbackHost(host)).toThrow('loopback binding only');
  });
});
