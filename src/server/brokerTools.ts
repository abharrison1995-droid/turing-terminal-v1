/** Tool definitions exposed by the Turing execution broker. Side-effect free so adapters can import it. */
export const BROKER_TOOL_DEFINITIONS = [
  {
    name: 'list_files',
    description: 'List immediate children of a directory inside the selected project.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project-relative directory; defaults to project root.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    description: 'Read a non-secret text file inside the selected project.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Project-relative file path.' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_file',
    description: 'Create or replace a non-secret text file inside the selected project.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project-relative file path.' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a regular file inside the selected project.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Project-relative file path.' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_command',
    description: 'Run a project command through Turing policy and approval controls.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'array', items: { type: 'string' }, minItems: 1 },
        cwd: { type: 'string', description: 'Optional project-relative working directory.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
] as const;

export const READ_ONLY_BROKER_TOOLS = new Set(['list_files', 'read_file']);
