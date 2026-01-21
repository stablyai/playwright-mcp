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

import { test as baseTest, expect } from '@playwright/test';

// Import LogBuffer directly for unit testing
const { LogBuffer, createLogger, REDACTED } = require('../src/custom/log-buffer');

const test = baseTest;

test.describe('LogBuffer', () => {
  test.describe('append and read', () => {
    test('appends and reads events', () => {
      const buffer = new LogBuffer();
      buffer.append('info', 'test', 'Hello world');
      buffer.append('debug', 'test', 'Debug message');

      const result = buffer.read();

      expect(result.events).toHaveLength(2);
      expect(result.events[0].message).toBe('Hello world');
      expect(result.events[0].level).toBe('info');
      expect(result.events[0].source).toBe('test');
      expect(result.events[1].message).toBe('Debug message');
    });

    test('returns empty events for empty buffer', () => {
      const buffer = new LogBuffer();
      const result = buffer.read();

      expect(result.events).toHaveLength(0);
      expect(result.has_more).toBe(false);
      expect(result.truncated).toBe(false);
    });

    test('includes structured data', () => {
      const buffer = new LogBuffer();
      buffer.append('info', 'test', 'Test message', { foo: 'bar', count: 42 });

      const result = buffer.read();

      expect(result.events[0].data).toEqual({ foo: 'bar', count: 42 });
    });

    test('excludes structured data when include_structured is false', () => {
      const buffer = new LogBuffer();
      buffer.append('info', 'test', 'Test message', { foo: 'bar' });

      const result = buffer.read({ includeStructured: false });

      expect(result.events[0].data).toBeNull();
    });
  });

  test.describe('cursor pagination', () => {
    test('returns cursor for incremental reading', () => {
      const buffer = new LogBuffer();
      for (let i = 0; i < 10; i++) {
        buffer.append('info', 'test', `Message ${i}`);
      }

      const result1 = buffer.read({ limit: 5 });
      expect(result1.events).toHaveLength(5);
      expect(result1.has_more).toBe(true);
      expect(result1.cursor).toBeTruthy();

      const result2 = buffer.read({ cursor: result1.cursor, limit: 5 });
      expect(result2.events).toHaveLength(5);
      expect(result2.events[0].message).toBe('Message 5');
    });

    test('returns empty events when cursor points to end', () => {
      const buffer = new LogBuffer();
      buffer.append('info', 'test', 'Message 1');
      buffer.append('info', 'test', 'Message 2');

      const result1 = buffer.read();
      const result2 = buffer.read({ cursor: result1.cursor });

      expect(result2.events).toHaveLength(0);
      expect(result2.has_more).toBe(false);
    });

    test('handles invalid cursor gracefully', () => {
      const buffer = new LogBuffer();
      buffer.append('info', 'test', 'Test message');

      const result = buffer.read({ cursor: 'invalid-cursor' });

      // Should start from beginning
      expect(result.events).toHaveLength(1);
    });
  });

  test.describe('retention policy', () => {
    test('drops oldest events when max events exceeded', () => {
      const buffer = new LogBuffer({ maxEvents: 5, maxBytes: 100 * 1024 * 1024 });

      for (let i = 0; i < 10; i++) {
        buffer.append('info', 'test', `Msg${i}`);
      }

      const stats = buffer.stats();
      expect(stats.eventCount).toBeLessThanOrEqual(5);
      expect(stats.droppedCount).toBeGreaterThanOrEqual(5);

      const result = buffer.read();
      // Verify the retained messages are the newest ones
      const messages = result.events.map(e => e.message);
      expect(messages).toContain('Msg9');
      expect(messages).not.toContain('Msg0');
    });

    test('drops oldest events when max bytes exceeded', () => {
      const buffer = new LogBuffer({ maxBytes: 500 }); // Small buffer

      for (let i = 0; i < 100; i++) {
        buffer.append('info', 'test', `This is a longer message number ${i}`);
      }

      const stats = buffer.stats();
      expect(stats.eventCount).toBeLessThan(100);
      expect(stats.droppedCount).toBeGreaterThan(0);
    });

    test('warns when cursor points to dropped data', () => {
      const buffer = new LogBuffer({ maxEvents: 3 });

      // Add initial events
      buffer.append('info', 'test', 'Message 1');
      buffer.append('info', 'test', 'Message 2');

      // Get cursor
      const result1 = buffer.read();
      const cursor = result1.cursor;

      // Add more events to trigger drop
      for (let i = 3; i <= 10; i++) {
        buffer.append('info', 'test', `Message ${i}`);
      }

      // Read with old cursor
      const result2 = buffer.read({ cursor });

      // Should have warning event
      const warningEvents = result2.events.filter(e =>
        e.source === 'log_buffer' && e.level === 'warn'
      );
      expect(warningEvents.length).toBeGreaterThanOrEqual(1);
      expect(warningEvents[0].message).toContain('dropped');
    });
  });

  test.describe('filtering', () => {
    test('filters by log level', () => {
      const buffer = new LogBuffer();
      buffer.append('debug', 'test', 'Debug');
      buffer.append('info', 'test', 'Info');
      buffer.append('warn', 'test', 'Warn');
      buffer.append('error', 'test', 'Error');

      const result = buffer.read({ levels: ['warn', 'error'] });

      expect(result.events).toHaveLength(2);
      expect(result.events[0].level).toBe('warn');
      expect(result.events[1].level).toBe('error');
    });

    test('filters by source', () => {
      const buffer = new LogBuffer();
      buffer.append('info', 'source1', 'From source1');
      buffer.append('info', 'source2', 'From source2');
      buffer.append('info', 'source1', 'Also from source1');

      const result = buffer.read({ sources: ['source1'] });

      expect(result.events).toHaveLength(2);
      expect(result.events.every(e => e.source === 'source1')).toBe(true);
    });

    test('combines level and source filters', () => {
      const buffer = new LogBuffer();
      buffer.append('info', 'source1', 'Info from source1');
      buffer.append('error', 'source1', 'Error from source1');
      buffer.append('error', 'source2', 'Error from source2');

      const result = buffer.read({ levels: ['error'], sources: ['source1'] });

      expect(result.events).toHaveLength(1);
      expect(result.events[0].source).toBe('source1');
      expect(result.events[0].level).toBe('error');
    });
  });

  test.describe('truncation', () => {
    test('truncates when max_bytes exceeded', () => {
      const buffer = new LogBuffer();

      // Add many events
      for (let i = 0; i < 100; i++) {
        buffer.append('info', 'test', `This is message number ${i} with some extra content to make it longer`);
      }

      const result = buffer.read({ maxBytes: 1000 });

      expect(result.truncated).toBe(true);
      expect(result.has_more).toBe(true);
      expect(JSON.stringify(result.events).length).toBeLessThan(1200);
    });

    test('respects limit', () => {
      const buffer = new LogBuffer();

      for (let i = 0; i < 100; i++) {
        buffer.append('info', 'test', `Message ${i}`);
      }

      const result = buffer.read({ limit: 10 });

      expect(result.events).toHaveLength(10);
      expect(result.has_more).toBe(true);
    });

    test('enforces hard cap on limit', () => {
      const buffer = new LogBuffer();

      for (let i = 0; i < 2000; i++) {
        buffer.append('info', 'test', `Message ${i}`);
      }

      const result = buffer.read({ limit: 2000 });

      // Should be capped at 1000
      expect(result.events.length).toBeLessThanOrEqual(1000);
    });
  });

  test.describe('sanitization', () => {
    test('redacts Authorization headers', () => {
      const buffer = new LogBuffer();
      buffer.append('info', 'test', 'Request with authorization: "Bearer token123"');

      const result = buffer.read();
      expect(result.events[0].message).toContain(REDACTED);
      expect(result.events[0].message).not.toContain('token123');
    });

    test('redacts cookies in messages', () => {
      const buffer = new LogBuffer();
      buffer.append('info', 'test', 'Headers: cookie: "session=abc123"');

      const result = buffer.read();
      expect(result.events[0].message).toContain(REDACTED);
      expect(result.events[0].message).not.toContain('abc123');
    });

    test('redacts API keys in messages', () => {
      const buffer = new LogBuffer();
      buffer.append('info', 'test', 'Using api_key: "sk-1234567890abcdef"');

      const result = buffer.read();
      expect(result.events[0].message).toContain(REDACTED);
      expect(result.events[0].message).not.toContain('sk-1234567890abcdef');
    });

    test('redacts passwords in messages', () => {
      const buffer = new LogBuffer();
      buffer.append('info', 'test', 'Login with password: "secretpass123"');

      const result = buffer.read();
      expect(result.events[0].message).toContain(REDACTED);
      expect(result.events[0].message).not.toContain('secretpass123');
    });

    test('redacts sensitive keys in structured data', () => {
      const buffer = new LogBuffer();
      buffer.append('info', 'test', 'Request', {
        headers: {
          authorization: 'Bearer secret123',
          'content-type': 'application/json',
        },
        password: 'userpass',
        api_key: 'api-key-value',
      });

      const result = buffer.read();
      const data = result.events[0].data;

      expect(data.password).toBe(REDACTED);
      expect(data.api_key).toBe(REDACTED);
      expect(data.headers.authorization).toBe(REDACTED);
      expect(data.headers['content-type']).toBe('application/json');
    });

    test('redacts access tokens', () => {
      const buffer = new LogBuffer();
      buffer.append('info', 'test', 'Got access_token: "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9"');

      const result = buffer.read();
      expect(result.events[0].message).toContain(REDACTED);
      expect(result.events[0].message).not.toContain('eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9');
    });

    test('preserves non-sensitive data', () => {
      const buffer = new LogBuffer();
      buffer.append('info', 'test', 'Normal message', {
        url: 'https://example.com',
        method: 'GET',
        status: 200,
      });

      const result = buffer.read();
      const data = result.events[0].data;

      expect(data.url).toBe('https://example.com');
      expect(data.method).toBe('GET');
      expect(data.status).toBe(200);
    });
  });

  test.describe('stack trace truncation', () => {
    test('truncates long stack traces for non-debug levels', () => {
      const buffer = new LogBuffer();

      // Create a message with a long stack trace
      const stackLines = [];
      for (let i = 0; i < 100; i++) {
        stackLines.push(`    at function${i} (file.js:${i}:1)`);
      }
      const message = 'Error occurred\n' + stackLines.join('\n');

      buffer.append('error', 'test', message);

      const result = buffer.read();
      const lines = result.events[0].message.split('\n');

      // Should be truncated to ~40 lines
      expect(lines.length).toBeLessThan(50);
      expect(result.events[0].message).toContain('more stack frames');
    });

    test('keeps full stack trace for debug level', () => {
      const buffer = new LogBuffer();

      const stackLines = [];
      for (let i = 0; i < 50; i++) {
        stackLines.push(`    at function${i} (file.js:${i}:1)`);
      }
      const message = 'Error occurred\n' + stackLines.join('\n');

      buffer.append('debug', 'test', message);

      const result = buffer.read();
      const lines = result.events[0].message.split('\n');

      // Should keep all lines for debug
      expect(lines.length).toBeGreaterThan(45);
    });
  });

  test.describe('createLogger helper', () => {
    test('creates logger bound to source', () => {
      const buffer = new LogBuffer();
      const logger = createLogger(buffer, 'my_component');

      logger.info('Info message');
      logger.debug('Debug message');
      logger.warn('Warning');
      logger.error('Error');

      const result = buffer.read();

      expect(result.events).toHaveLength(4);
      expect(result.events.every(e => e.source === 'my_component')).toBe(true);
      expect(result.events[0].level).toBe('info');
      expect(result.events[1].level).toBe('debug');
      expect(result.events[2].level).toBe('warn');
      expect(result.events[3].level).toBe('error');
    });

    test('logger supports structured data', () => {
      const buffer = new LogBuffer();
      const logger = createLogger(buffer, 'test');

      logger.info('Test', { key: 'value' });

      const result = buffer.read();
      expect(result.events[0].data).toEqual({ key: 'value' });
    });
  });

  test.describe('stats', () => {
    test('returns buffer statistics', () => {
      const buffer = new LogBuffer();

      buffer.append('info', 'test', 'Message 1');
      buffer.append('info', 'test', 'Message 2');

      const stats = buffer.stats();

      expect(stats.eventCount).toBe(2);
      expect(stats.totalBytes).toBeGreaterThan(0);
      expect(stats.droppedCount).toBe(0);
      expect(stats.currentSeq).toBe(2);
    });

    test('tracks dropped count', () => {
      const buffer = new LogBuffer({ maxEvents: 2 });

      buffer.append('info', 'test', 'Message 1');
      buffer.append('info', 'test', 'Message 2');
      buffer.append('info', 'test', 'Message 3');

      const stats = buffer.stats();

      expect(stats.eventCount).toBe(2);
      expect(stats.droppedCount).toBe(1);
    });
  });

  test.describe('clear', () => {
    test('clears all events', () => {
      const buffer = new LogBuffer();

      buffer.append('info', 'test', 'Message 1');
      buffer.append('info', 'test', 'Message 2');
      buffer.clear();

      const result = buffer.read();
      expect(result.events).toHaveLength(0);
    });

    test('preserves sequence number after clear', () => {
      const buffer = new LogBuffer();

      buffer.append('info', 'test', 'Message 1');
      const oldSeq = buffer.stats().currentSeq;

      buffer.clear();
      buffer.append('info', 'test', 'New message');

      const newSeq = buffer.stats().currentSeq;
      expect(newSeq).toBe(oldSeq + 1);
    });
  });
});
