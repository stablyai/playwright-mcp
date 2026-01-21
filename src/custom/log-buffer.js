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

/**
 * Log levels in order of severity (least to most severe)
 */
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

/**
 * Patterns that indicate sensitive data to redact
 */
const REDACTION_PATTERNS = [
  // Authorization headers
  /authorization['":\s]*['"](Bearer|Basic|Digest|OAuth)\s+[^'"]+['"]/gi,
  /Bearer\s+[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/gi,
  /Basic\s+[A-Za-z0-9+/=]+/gi,
  // Cookie values
  /cookie['":\s]*['"][^'"]+['"]/gi,
  /set-cookie['":\s]*['"][^'"]+['"]/gi,
  // Access tokens
  /access[_-]?token['":\s]*['"][^'"]+['"]/gi,
  /refresh[_-]?token['":\s]*['"][^'"]+['"]/gi,
  /id[_-]?token['":\s]*['"][^'"]+['"]/gi,
  // API keys
  /api[_-]?key['":\s]*['"][^'"]+['"]/gi,
  /apikey['":\s]*['"][^'"]+['"]/gi,
  /x-api-key['":\s]*['"][^'"]+['"]/gi,
  // Passwords and secrets
  /password['":\s]*['"][^'"]+['"]/gi,
  /passwd['":\s]*['"][^'"]+['"]/gi,
  /secret['":\s]*['"][^'"]+['"]/gi,
  /private[_-]?key['":\s]*['"][^'"]+['"]/gi,
  // AWS credentials
  /aws[_-]?access[_-]?key[_-]?id['":\s]*['"][^'"]+['"]/gi,
  /aws[_-]?secret[_-]?access[_-]?key['":\s]*['"][^'"]+['"]/gi,
  // Generic token patterns
  /token['":\s]*['"][A-Za-z0-9\-_]{20,}['"]/gi,
];

/**
 * Replacement string for redacted values
 */
const REDACTED = '***REDACTED***';

/**
 * Maximum stack trace lines to include (for non-debug levels)
 */
const MAX_STACK_LINES = 40;

/**
 * Default configuration
 */
const DEFAULT_CONFIG = {
  maxEvents: 10000,
  maxBytes: 10 * 1024 * 1024, // 10 MB
};

/**
 * LogEvent represents a single log entry
 */
class LogEvent {
  constructor(seq, level, source, message, data = null) {
    this.seq = seq;
    this.ts = new Date().toISOString();
    this.level = level;
    this.source = source;
    this.message = message;
    this.data = data;
    this._size = this._calculateSize();
  }

  _calculateSize() {
    // Rough estimate of serialized size
    let size = this.ts.length + this.level.length + this.source.length + this.message.length + 100;
    if (this.data) {
      size += JSON.stringify(this.data).length;
    }
    return size;
  }

  toJSON(includeStructured = true) {
    const result = {
      ts: this.ts,
      level: this.level,
      source: this.source,
      message: this.message,
    };
    if (includeStructured && this.data !== null) {
      result.data = this.data;
    } else {
      result.data = null;
    }
    return result;
  }
}

/**
 * LogBuffer implements a ring buffer for session-scoped logs with:
 * - Retention policy (max events and max bytes)
 * - Monotonic sequence numbers for cursor-based pagination
 * - Filtering by level and source
 * - Sanitization of sensitive data
 */
class LogBuffer {
  constructor(config = {}) {
    this._config = { ...DEFAULT_CONFIG, ...config };
    this._events = [];
    this._seq = 0;
    this._totalBytes = 0;
    this._droppedCount = 0;
    this._earliestRetainedSeq = 0;
  }

  /**
   * Append a log event to the buffer
   * @param {string} level - Log level (debug, info, warn, error)
   * @param {string} source - Component/tool that emitted the event
   * @param {string} message - Human-readable message
   * @param {object|null} data - Optional structured data
   * @returns {number} The sequence number of the appended event
   */
  append(level, source, message, data = null) {
    // Validate level
    if (!LOG_LEVELS.includes(level)) {
      level = 'info';
    }

    // Sanitize message and data
    const sanitizedMessage = this._sanitize(message);
    const sanitizedData = data ? this._sanitizeObject(data) : null;

    // Truncate stack traces for non-debug levels
    const truncatedMessage = level !== 'debug'
      ? this._truncateStackTrace(sanitizedMessage)
      : sanitizedMessage;

    // Create event
    const seq = ++this._seq;
    const event = new LogEvent(seq, level, source, truncatedMessage, sanitizedData);

    // Add to buffer
    this._events.push(event);
    this._totalBytes += event._size;

    // Enforce retention policy
    this._enforceRetention();

    return seq;
  }

  /**
   * Read events from the buffer with filtering and pagination
   * @param {object} options - Read options
   * @param {string|null} options.cursor - Cursor from previous read (null for start)
   * @param {number} options.limit - Maximum events to return (default 200, max 1000)
   * @param {number} options.maxBytes - Maximum response size (default 256KB, max 1MB)
   * @param {string[]|null} options.levels - Filter by levels
   * @param {string[]|null} options.sources - Filter by sources
   * @param {boolean} options.includeStructured - Include structured data (default true)
   * @returns {object} Result with events, cursor, has_more, truncated
   */
  read(options = {}) {
    const {
      cursor = null,
      limit = 200,
      maxBytes = 256000,
      levels = null,
      sources = null,
      includeStructured = true,
    } = options;

    // Parse cursor
    const startSeq = cursor ? this._decodeCursor(cursor) : 0;

    // Validate and cap limits
    const effectiveLimit = Math.min(Math.max(1, limit), 1000);
    const effectiveMaxBytes = Math.min(Math.max(1000, maxBytes), 1000000);

    // Prepare result
    const result = {
      cursor: '',
      has_more: false,
      events: [],
      truncated: false,
    };

    // Check if cursor points to dropped data
    if (startSeq > 0 && startSeq < this._earliestRetainedSeq) {
      // Insert warning event at the beginning
      result.events.push({
        ts: new Date().toISOString(),
        level: 'warn',
        source: 'log_buffer',
        message: `Cursor pointed to dropped data. ${this._droppedCount} events were dropped due to retention policy. Resuming from earliest retained event.`,
        data: null,
      });
    }

    // Calculate effective start sequence
    const effectiveStartSeq = Math.max(startSeq, this._earliestRetainedSeq);

    // Filter and collect events
    let currentBytes = JSON.stringify(result.events).length;
    let lastSeq = effectiveStartSeq;

    for (const event of this._events) {
      if (event.seq <= effectiveStartSeq) {
        continue;
      }

      // Apply level filter
      if (levels && levels.length > 0 && !levels.includes(event.level)) {
        continue;
      }

      // Apply source filter
      if (sources && sources.length > 0 && !sources.includes(event.source)) {
        continue;
      }

      // Check byte limit
      const eventJson = event.toJSON(includeStructured);
      const eventSize = JSON.stringify(eventJson).length + 2; // +2 for comma and space

      if (currentBytes + eventSize > effectiveMaxBytes) {
        result.truncated = true;
        result.has_more = true;
        break;
      }

      // Check event limit
      if (result.events.length >= effectiveLimit) {
        result.has_more = true;
        break;
      }

      result.events.push(eventJson);
      currentBytes += eventSize;
      lastSeq = event.seq;
    }

    // Check if there are more events after the last returned
    if (!result.has_more && this._events.length > 0) {
      const lastEventSeq = this._events[this._events.length - 1].seq;
      result.has_more = lastSeq < lastEventSeq;
    }

    // Encode cursor
    result.cursor = this._encodeCursor(lastSeq);

    return result;
  }

  /**
   * Get buffer statistics
   */
  stats() {
    return {
      eventCount: this._events.length,
      totalBytes: this._totalBytes,
      droppedCount: this._droppedCount,
      currentSeq: this._seq,
      earliestRetainedSeq: this._earliestRetainedSeq,
    };
  }

  /**
   * Clear all events from the buffer
   */
  clear() {
    this._events = [];
    this._totalBytes = 0;
    this._droppedCount = 0;
    this._earliestRetainedSeq = this._seq;
  }

  /**
   * Enforce retention policy by dropping oldest events
   */
  _enforceRetention() {
    while (
      this._events.length > this._config.maxEvents ||
      this._totalBytes > this._config.maxBytes
    ) {
      const dropped = this._events.shift();
      if (dropped) {
        this._totalBytes -= dropped._size;
        this._droppedCount++;
        this._earliestRetainedSeq = this._events.length > 0
          ? this._events[0].seq
          : this._seq;
      } else {
        break;
      }
    }
  }

  /**
   * Sanitize a string by redacting sensitive patterns
   */
  _sanitize(text) {
    if (typeof text !== 'string') {
      return String(text);
    }

    let result = text;
    for (const pattern of REDACTION_PATTERNS) {
      result = result.replace(pattern, (match) => {
        // Keep the key name but redact the value
        const colonIndex = match.indexOf(':');
        const equalsIndex = match.indexOf('=');
        const separatorIndex = colonIndex !== -1 ? colonIndex : equalsIndex;

        if (separatorIndex !== -1) {
          return match.substring(0, separatorIndex + 1) + ` "${REDACTED}"`;
        }
        return REDACTED;
      });
    }

    return result;
  }

  /**
   * Recursively sanitize an object
   */
  _sanitizeObject(obj) {
    if (obj === null || obj === undefined) {
      return null;
    }

    if (typeof obj === 'string') {
      return this._sanitize(obj);
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this._sanitizeObject(item));
    }

    if (typeof obj === 'object') {
      const result = {};
      for (const [key, value] of Object.entries(obj)) {
        const lowerKey = key.toLowerCase();

        // Redact known sensitive keys
        if (
          lowerKey.includes('password') ||
          lowerKey.includes('secret') ||
          lowerKey.includes('token') ||
          lowerKey.includes('apikey') ||
          lowerKey.includes('api_key') ||
          lowerKey.includes('authorization') ||
          lowerKey.includes('cookie') ||
          lowerKey.includes('credential')
        ) {
          result[key] = REDACTED;
        } else if (typeof value === 'object') {
          result[key] = this._sanitizeObject(value);
        } else if (typeof value === 'string') {
          result[key] = this._sanitize(value);
        } else {
          result[key] = value;
        }
      }
      return result;
    }

    return obj;
  }

  /**
   * Truncate stack traces to MAX_STACK_LINES
   */
  _truncateStackTrace(message) {
    const lines = message.split('\n');
    if (lines.length <= MAX_STACK_LINES) {
      return message;
    }

    // Find stack trace start (lines starting with 'at ')
    let stackStart = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith('at ')) {
        stackStart = i;
        break;
      }
    }

    if (stackStart === -1) {
      // No stack trace found, truncate normally
      return lines.slice(0, MAX_STACK_LINES).join('\n') + '\n... (truncated)';
    }

    // Keep message lines and truncate stack trace
    const messageLines = lines.slice(0, stackStart);
    const stackLines = lines.slice(stackStart);
    const maxStackLines = MAX_STACK_LINES - messageLines.length;

    if (stackLines.length <= maxStackLines) {
      return message;
    }

    const truncatedStack = stackLines.slice(0, maxStackLines);
    const omitted = stackLines.length - maxStackLines;

    return [...messageLines, ...truncatedStack, `... (${omitted} more stack frames)`].join('\n');
  }

  /**
   * Encode a sequence number as an opaque cursor
   */
  _encodeCursor(seq) {
    return Buffer.from(JSON.stringify({ v: 1, s: seq })).toString('base64url');
  }

  /**
   * Decode a cursor to a sequence number
   */
  _decodeCursor(cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (decoded.v === 1 && typeof decoded.s === 'number') {
        return decoded.s;
      }
    } catch {
      // Invalid cursor, start from beginning
    }
    return 0;
  }
}

/**
 * Create a logger instance bound to a specific source
 */
function createLogger(buffer, source) {
  return {
    debug: (message, data) => buffer.append('debug', source, message, data),
    info: (message, data) => buffer.append('info', source, message, data),
    warn: (message, data) => buffer.append('warn', source, message, data),
    error: (message, data) => buffer.append('error', source, message, data),
  };
}

module.exports = {
  LogBuffer,
  LogEvent,
  createLogger,
  LOG_LEVELS,
  REDACTED,
};
