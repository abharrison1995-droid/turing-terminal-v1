const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function assertLoopbackHost(host: string): void {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      'Turing Terminal supports loopback binding only. For remote phone access, keep this listener local and use Tailscale Serve with desktop-approved device pairing.',
    );
  }
}
