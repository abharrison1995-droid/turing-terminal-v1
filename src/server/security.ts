export function safeChildEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  const sensitiveName =
    /(^|_)(TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|PASSPHRASE|CREDENTIALS?|AUTH_CONFIG)(_|$)/i;
  for (const key of Object.keys(env)) {
    if (sensitiveName.test(key) || /^(OPENAI|ANTHROPIC)_BASE_URL$/i.test(key)) delete env[key];
  }
  return env;
}

export function redactSecrets(value: string): string {
  return value
    .replace(
      /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
      '[REDACTED_PRIVATE_KEY]',
    )
    .replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_API_KEY]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_TOKEN]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]')
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[REDACTED_GOOGLE_KEY]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_SLACK_TOKEN]')
    .replace(/\b((?:https?|ssh):\/\/)[^/\s@]+@/gi, '$1[REDACTED]@')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{12,}/gi, '$1[REDACTED_TOKEN]')
    .replace(
      /((?:[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)[A-Z0-9_]*|(?:token|secret|password|api[_-]?key|access[_-]?key|private[_-]?key|credentials?))\s*[:=]\s*["']?)[^\s"',;}]+/gi,
      '$1[REDACTED]',
    );
}
