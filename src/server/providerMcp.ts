import { createInterface } from 'node:readline';

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  jsonrpc?: string;
}

import { BROKER_TOOL_DEFINITIONS } from './brokerTools.js';

export { BROKER_TOOL_DEFINITIONS };

const BROKER_URL = process.env.TT_TOOL_BROKER_URL;
const BROKER_TOKEN = process.env.TT_TOOL_BROKER_TOKEN;

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  void handleLine(line);
});

async function handleLine(line: string): Promise<void> {
  let message: JsonRpcMessage;
  try {
    message = JSON.parse(line) as JsonRpcMessage;
  } catch {
    return;
  }
  if (message.id === undefined || !message.method) return;
  try {
    let result: unknown;
    if (message.method === 'initialize') {
      const requested = message.params?.protocolVersion;
      result = {
        protocolVersion: typeof requested === 'string' ? requested : '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'turing-execution-broker', version: '1.0.0' },
      };
    } else if (message.method === 'ping') {
      result = {};
    } else if (message.method === 'tools/list') {
      result = { tools: BROKER_TOOL_DEFINITIONS };
    } else if (message.method === 'tools/call') {
      if (!BROKER_URL || !BROKER_TOKEN)
        throw new Error('Turing provider MCP server requires its per-session broker connection.');
      const params = message.params ?? {};
      const name = typeof params.name === 'string' ? params.name : '';
      const args = params.arguments;
      if (!BROKER_TOOL_DEFINITIONS.some((tool) => tool.name === name))
        throw new Error('The requested tool is not exposed by the Turing broker.');
      const response = await fetch(BROKER_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${BROKER_TOKEN}` },
        body: JSON.stringify({ toolName: name, input: args }),
        signal: AbortSignal.timeout(30 * 60 * 1_000),
      });
      const body = (await response.json()) as { result?: unknown; error?: string };
      if (!response.ok || body.error)
        throw new Error(body.error ?? `Broker returned HTTP ${response.status}.`);
      result = {
        content: [
          { type: 'text', text: typeof body.result === 'string' ? body.result : JSON.stringify(body.result) },
        ],
      };
    } else if (message.method.startsWith('notifications/')) {
      return;
    } else {
      throw new Error(`Unsupported MCP method: ${message.method}`);
    }
    reply({ jsonrpc: '2.0', id: message.id, result });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'Turing broker request failed.';
    if (message.method === 'tools/call') {
      reply({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: messageText }], isError: true },
      });
    } else {
      reply({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: messageText } });
    }
  }
}

function reply(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
