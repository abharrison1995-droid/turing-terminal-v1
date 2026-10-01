import { describe, expect, it } from 'vitest';
import { redactSecrets, safeChildEnvironment } from './security.js';

describe('secret handling', () => {
  it('removes credential-shaped variables while keeping ordinary runtime configuration', () => {
    const source = {
      PATH: '/usr/bin',
      HOME: '/home/example',
      OPENAI_API_KEY: 'sk-private',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-private',
      AWS_SECRET_ACCESS_KEY: 'aws-private',
      AWS_ACCESS_KEY_ID: 'aws-id',
      NPM_TOKEN: 'npm-private',
      TT_PORT: '4317',
    };
    const child = safeChildEnvironment(source);
    expect(child.PATH).toBe('/usr/bin');
    expect(child.HOME).toBe('/home/example');
    expect(child.TT_PORT).toBe('4317');
    expect(child).not.toHaveProperty('OPENAI_API_KEY');
    expect(child).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(child).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(child).not.toHaveProperty('AWS_ACCESS_KEY_ID');
    expect(child).not.toHaveProperty('NPM_TOKEN');
  });

  it('redacts API keys, bearer tokens, and secret assignments', () => {
    const output = redactSecrets(
      'OPENAI_API_KEY=sk-testsecretvalue123456789 Bearer token_12345678901234567890 AWS_SECRET_ACCESS_KEY=abcdef0123456789',
    );
    expect(output).not.toContain('sk-testsecretvalue');
    expect(output).not.toContain('token_123456789');
    expect(output).not.toContain('abcdef0123456789');
    expect(output).toContain('[REDACTED');
  });

  it('redacts private key blocks and common cloud/service key formats', () => {
    const value = [
      '-----BEGIN PRIVATE KEY-----',
      'private-material',
      '-----END PRIVATE KEY-----',
      'AKIA1234567890ABCDEF',
      'AIza1234567890abcdefghijklmnopqrstuvwxyzAB',
      'xoxb-12345678901234567890',
    ].join(' ');
    const redacted = redactSecrets(value);
    expect(redacted).not.toContain('private-material');
    expect(redacted).not.toContain('AKIA1234567890ABCDEF');
    expect(redacted).not.toContain('AIza1234567890abcdefghijklmnopqrstuvwxyzAB');
    expect(redacted).not.toContain('xoxb-12345678901234567890');
  });

  it('redacts credentials embedded in Git remote URLs', () => {
    const output = redactSecrets('fatal: push to https://alice:remote-password@example.test/repo.git failed');
    expect(output).not.toContain('alice:remote-password');
    expect(output).toContain('https://[REDACTED]@example.test/repo.git');
  });
});
