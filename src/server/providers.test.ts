import { describe, expect, it } from 'vitest';
import {
  parseClaudeAuthStatus,
  parseCodexAuthStatus,
  parseCodexModels,
  parseCodexOutput,
  parseOpenCodeModels,
  openCodeModelSelector,
  parseProviderOutput,
  safeClaudeSubscriptionEnvironment,
  safeCodexSubscriptionEnvironment,
} from './providers.js';

describe('provider output contract', () => {
  it('preserves an OpenCode native provider/model#variant selector exactly', () => {
    expect(openCodeModelSelector('openai/gpt-5.2', 'high')).toBe('openai/gpt-5.2#high');
    expect(openCodeModelSelector('openai/gpt-5.2')).toBe('openai/gpt-5.2');
  });

  it('discovers exact OpenCode variants and safe capability metadata from verbose catalog output', () => {
    const models = parseOpenCodeModels(`opencode-go/kimi-k3\n{\n  "name": "Kimi K3",\n  "variants": {\n    "high": { "settings": { "reasoningEffort": "high" } },\n    "max": { "settings": { "reasoningEffort": "max" } }\n  },\n  "capabilities": { "tools": true, "input": ["text"], "output": ["text"], "secret": "must-not-be-retained" },\n  "apiKey": "must-not-be-retained"\n}\n`);
    expect(models).toEqual([{
      id: 'opencode-go/kimi-k3',
      name: 'Kimi K3',
      providerId: 'opencode-go',
      subscriptionBacked: true,
      variantIds: ['high', 'max'],
      capabilities: { tools: true, input: ['text'], output: ['text'] },
      supportsTools: true,
    }]);
  });

  it('accepts ChatGPT sign-in and discovers only visible Codex app-server models', () => {
    expect(parseCodexAuthStatus('Logged in using ChatGPT')).toBe('chatgpt');
    expect(parseCodexAuthStatus('Logged in using API key')).toBe('api_key');
    expect(parseCodexAuthStatus('Not logged in')).toBeNull();
    expect(
      parseCodexModels({
        data: [
          {
            id: 'gpt-6-luna',
            displayName: 'GPT-6 Luna',
            supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
          },
          { id: 'hidden-model', hidden: true },
          { id: '', displayName: 'Invalid' },
        ],
      }),
    ).toEqual([
      {
        id: 'gpt-6-luna',
        name: 'GPT-6 Luna',
        providerId: 'openai-codex',
        subscriptionBacked: true,
        reasoningLevels: ['low', 'high'],
      },
    ]);
  });

  it('removes API-key and provider overrides from Codex subscription runs', () => {
    const env = safeCodexSubscriptionEnvironment({
      HOME: '/home/test',
      PATH: '/usr/bin',
      CODEX_HOME: '/home/test/.codex',
      OPENAI_API_KEY: 'metered-key',
      OPENAI_BASE_URL: 'https://api.example.invalid',
      CODEX_API_KEY: 'another-metered-key',
      CODEX_MODEL_PROVIDER: 'api',
    });
    expect(env).toMatchObject({ HOME: '/home/test', PATH: '/usr/bin', CODEX_HOME: '/home/test/.codex' });
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env).not.toHaveProperty('OPENAI_BASE_URL');
    expect(env).not.toHaveProperty('CODEX_API_KEY');
    expect(env).not.toHaveProperty('CODEX_MODEL_PROVIDER');
  });

  it('parses Codex JSONL output and provider-reported usage', () => {
    const result = parseCodexOutput(
      [
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'Broker run complete.' },
        }),
        JSON.stringify({
          type: 'turn.completed',
          turn: { status: 'completed', usage: { input_tokens: 250, output_tokens: 80 } },
        }),
      ].join('\n'),
    );
    expect(result.text).toContain('Broker run complete.');
    expect(result.inputTokens).toBe(250);
    expect(result.outputTokens).toBe(80);
    expect(result.usageProvenance).toBe('provider_reported');
  });

  it('recognizes subscription authentication without persisting account identifiers', () => {
    const status = parseClaudeAuthStatus(
      JSON.stringify({
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
        email: 'private@example.invalid',
      }),
    );
    expect(status).toEqual({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' });
    expect(
      parseClaudeAuthStatus(JSON.stringify({ loggedIn: true, authMethod: 'apiKey', apiProvider: 'console' }))
        .apiProvider,
    ).toBe('console');
    expect(parseClaudeAuthStatus('not-json').loggedIn).toBeNull();
  });

  it('removes API and alternate-provider environment overrides from Claude subscription runs', () => {
    const env = safeClaudeSubscriptionEnvironment({
      HOME: '/home/test',
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'metered-key',
      ANTHROPIC_BASE_URL: 'https://api.example.invalid',
      ANTHROPIC_MODEL: 'metered-model',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      OPENAI_API_KEY: 'other-metered-key',
    });
    expect(env).toMatchObject({ HOME: '/home/test', PATH: '/usr/bin' });
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('ANTHROPIC_BASE_URL');
    expect(env).not.toHaveProperty('ANTHROPIC_MODEL');
    expect(env).not.toHaveProperty('CLAUDE_CODE_USE_BEDROCK');
    expect(env).not.toHaveProperty('CLAUDE_CODE_USE_VERTEX');
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
  });

  it('extracts streamed response text and provider-reported token counts', () => {
    const output = [
      JSON.stringify({ type: 'text', part: { text: 'Review complete.' } }),
      JSON.stringify({ type: 'result', result: 'No supported findings.' }),
      JSON.stringify({ type: 'result', usage: { input_tokens: 123, output_tokens: 45 } }),
    ].join('\n');
    const parsed = parseProviderOutput(output, 'opencode', 0);
    expect(parsed.text).toContain('Review complete.');
    expect(parsed.text).toContain('No supported findings.');
    expect(parsed.inputTokens).toBe(123);
    expect(parsed.outputTokens).toBe(45);
    expect(parsed.usageProvenance).toBe('provider_reported');
  });

  it('leaves unavailable token counts null and redacts credentials from output', () => {
    const parsed = parseProviderOutput('Plain response: OPENAI_API_KEY=sk-testsecretvalue123456789', 'cline');
    expect(parsed.text).toContain('Plain response:');
    expect(parsed.text).not.toContain('testsecretvalue');
    expect(parsed.stdout).not.toContain('testsecretvalue');
    expect(parsed.inputTokens).toBeNull();
    expect(parsed.outputTokens).toBeNull();
    expect(parsed.usageProvenance).toBe('unavailable');
  });

  it('reads Claude Code usage events without inferring missing tokens', () => {
    const parsed = parseProviderOutput(
      JSON.stringify({ type: 'result', result: 'Done.', usage: { input_tokens: 96 } }),
      'claude-code',
    );
    expect(parsed.inputTokens).toBe(96);
    expect(parsed.outputTokens).toBeNull();
    expect(parsed.usageProvenance).toBe('provider_reported');
  });
});
