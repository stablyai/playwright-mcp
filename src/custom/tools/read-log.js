/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const path = require('path');

// Get path to playwright internals (not exported via package.json exports)
const playwrightCorePath = path.dirname(require.resolve('playwright-core/package.json'));
const playwrightPath = path.dirname(require.resolve('playwright/package.json'));

const { z } = require(path.join(playwrightCorePath, 'lib/mcpBundle'));
const { defineTool } = require(path.join(playwrightPath, 'lib/mcp/browser/tools/tool'));

/**
 * read_log tool definition
 */
const readLog = defineTool({
  capability: 'core',

  schema: {
    name: 'read_log',
    title: 'Read server logs',
    description: 'Return recent server logs for this MCP session. Supports incremental reads via cursor.',

    inputSchema: z.object({
      cursor: z.string().nullable().optional()
        .describe('Opaque cursor from previous call; null or omitted means start from earliest retained'),
      limit: z.number().int().min(1).max(1000).nullable().optional()
        .describe('Max events to return; default 200; hard cap 1000'),
      max_bytes: z.number().int().min(1000).max(1000000).nullable().optional()
        .describe('Cap response size; default 256000; hard cap 1000000'),
      levels: z.array(z.enum(['debug', 'info', 'warn', 'error'])).nullable().optional()
        .describe('Subset of log levels to return; default all'),
      sources: z.array(z.string()).nullable().optional()
        .describe('Filter by component/tool name'),
      include_structured: z.boolean().nullable().optional()
        .describe('Include structured data fields; default true'),
    }),

    type: 'readOnly',
  },

  handle: async (context, params, response) => {
    // Get the log buffer from the context
    const logBuffer = context._logBuffer;

    if (!logBuffer) {
      response.addError('Log buffer not initialized for this session');
      return;
    }

    // Build read options
    const options = {
      cursor: params.cursor ?? null,
      limit: params.limit ?? 200,
      maxBytes: params.max_bytes ?? 256000,
      levels: params.levels ?? null,
      sources: params.sources ?? null,
      includeStructured: params.include_structured ?? true,
    };

    try {
      // Read events from buffer
      const result = logBuffer.read(options);

      // Format the response as JSON
      const output = {
        cursor: result.cursor,
        has_more: result.has_more,
        events: result.events,
        truncated: result.truncated,
      };

      response.addResult(JSON.stringify(output, null, 2));
    } catch (error) {
      response.addError(`Failed to read logs: ${error.message}`);
    }
  },
});

module.exports = [readLog];
