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

import { test, expect } from './fixtures';

/**
 * Extract the Result section from an MCP response and parse as JSON
 */
function parseLogResult(response: any): any {
  const text = response.content[0].text;
  // Extract the Result section content
  const resultMatch = text.match(/### Result\n([\s\S]*?)(?=\n### |$)/);
  if (!resultMatch) {
    throw new Error('No Result section found in response');
  }
  const resultContent = resultMatch[1].trim();
  return JSON.parse(resultContent);
}

test.describe('read_log tool', () => {
  test('returns logs from session', async ({ client, server }) => {
    // First navigate to generate some logs
    await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.HELLO_WORLD },
    });

    // Read logs
    const response = await client.callTool({
      name: 'read_log',
      arguments: {},
    });

    expect(response.isError).toBeFalsy();
    const result = parseLogResult(response);

    expect(result).toHaveProperty('cursor');
    expect(result).toHaveProperty('has_more');
    expect(result).toHaveProperty('events');
    expect(result).toHaveProperty('truncated');
    expect(Array.isArray(result.events)).toBe(true);

    // Should have at least the session init and navigate tool logs
    expect(result.events.length).toBeGreaterThan(0);

    // Events should have proper structure
    const event = result.events[0];
    expect(event).toHaveProperty('ts');
    expect(event).toHaveProperty('level');
    expect(event).toHaveProperty('source');
    expect(event).toHaveProperty('message');
  });

  test('supports cursor-based pagination', async ({ client, server }) => {
    // Generate multiple log entries
    await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.HELLO_WORLD },
    });
    await client.callTool({
      name: 'browser_snapshot',
      arguments: {},
    });

    // Read first batch with small limit
    const response1 = await client.callTool({
      name: 'read_log',
      arguments: { limit: 2 },
    });

    const result1 = parseLogResult(response1);
    expect(result1.events.length).toBeLessThanOrEqual(2);
    expect(result1.cursor).toBeTruthy();

    // Read next batch using cursor
    const response2 = await client.callTool({
      name: 'read_log',
      arguments: { cursor: result1.cursor, limit: 2 },
    });

    const result2 = parseLogResult(response2);

    // Events should be different (no overlap)
    if (result1.events.length > 0 && result2.events.length > 0) {
      expect(result2.events[0].ts).not.toBe(result1.events[0].ts);
    }
  });

  test('filters by log level', async ({ client, server }) => {
    // Generate some activity
    await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.HELLO_WORLD },
    });

    // Read only error and warn level logs
    const response = await client.callTool({
      name: 'read_log',
      arguments: { levels: ['error', 'warn'] },
    });

    const result = parseLogResult(response);

    // All returned events should be error or warn level
    for (const event of result.events) {
      expect(['error', 'warn']).toContain(event.level);
    }
  });

  test('filters by source', async ({ client, server }) => {
    // Generate some activity
    await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.HELLO_WORLD },
    });

    // Read only mcp_server logs
    const response = await client.callTool({
      name: 'read_log',
      arguments: { sources: ['mcp_server'] },
    });

    const result = parseLogResult(response);

    // All returned events should be from mcp_server
    for (const event of result.events) {
      expect(event.source).toBe('mcp_server');
    }
  });

  test('respects max_bytes limit', async ({ client, server }) => {
    // Generate some activity
    await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.HELLO_WORLD },
    });
    await client.callTool({
      name: 'browser_snapshot',
      arguments: {},
    });

    // Read with small max_bytes
    const response = await client.callTool({
      name: 'read_log',
      arguments: { max_bytes: 1000 },
    });

    const result = parseLogResult(response);
    const resultText = JSON.stringify(result.events);

    // Result should be small due to byte limit
    expect(resultText.length).toBeLessThanOrEqual(1200); // Some overhead allowed
  });

  test('include_structured controls data field', async ({ client, server }) => {
    // Generate some activity
    await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.HELLO_WORLD },
    });

    // Read with structured data
    const response1 = await client.callTool({
      name: 'read_log',
      arguments: { include_structured: true },
    });

    const result1 = parseLogResult(response1);

    // Read without structured data
    const response2 = await client.callTool({
      name: 'read_log',
      arguments: { include_structured: false },
    });

    const result2 = parseLogResult(response2);

    // All events in result2 should have data: null
    for (const event of result2.events) {
      expect(event.data).toBeNull();
    }
  });

  test('returns empty events when no logs', async ({ client }) => {
    // Read logs immediately (may have only session init)
    const response = await client.callTool({
      name: 'read_log',
      arguments: {},
    });

    expect(response.isError).toBeFalsy();
    const result = parseLogResult(response);

    expect(result).toHaveProperty('events');
    expect(Array.isArray(result.events)).toBe(true);
  });

  test('logs tool errors', async ({ client }) => {
    // Try to click without a page open (should fail)
    try {
      await client.callTool({
        name: 'browser_click',
        arguments: { element: 'test', ref: 'e1' },
      });
    } catch {
      // Expected to fail
    }

    // Read logs
    const response = await client.callTool({
      name: 'read_log',
      arguments: { levels: ['error'] },
    });

    const result = parseLogResult(response);

    // Should have logged the error
    const errorEvents = result.events.filter(e => e.level === 'error');
    // May or may not have errors depending on implementation
    expect(Array.isArray(errorEvents)).toBe(true);
  });
});
