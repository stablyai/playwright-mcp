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
const { customTools } = require('./tools');
const { LogBuffer, createLogger } = require('./log-buffer');

// Get path to playwright internals (not exported via package.json exports)
const playwrightPath = path.dirname(require.resolve('playwright/package.json'));
const { Response } = require(path.join(playwrightPath, 'lib/mcp/browser/response.js'));
const { toMcpTool } = require(path.join(playwrightPath, 'lib/mcp/sdk/tool.js'));

/**
 * Creates a patched version of BrowserServerBackend that includes custom tools.
 * This approach extends the existing backend rather than modifying it directly.
 *
 * @param {typeof import('playwright/lib/mcp/browser/browserServerBackend').BrowserServerBackend} BrowserServerBackend
 * @returns {typeof import('playwright/lib/mcp/browser/browserServerBackend').BrowserServerBackend}
 */
function createPatchedBackend(BrowserServerBackend) {
  return class PatchedBrowserServerBackend extends BrowserServerBackend {
    constructor(config, factory) {
      super(config, factory);
      // Add custom tools to the existing tools array
      this._customTools = customTools;
      // Create session-scoped log buffer
      this._logBuffer = new LogBuffer();
    }

    async initialize(clientInfo) {
      await super.initialize(clientInfo);
      // Attach log buffer to context for use by tools
      if (this._context) {
        this._context._logBuffer = this._logBuffer;
      }
      // Log session initialization
      const logger = createLogger(this._logBuffer, 'mcp_server');
      logger.info('MCP session initialized', {
        clientName: clientInfo?.name,
        clientVersion: clientInfo?.version,
      });
    }

    async listTools() {
      const baseTools = await super.listTools();
      const customToolSchemas = this._customTools.map(tool => toMcpTool(tool.schema));
      return [...baseTools, ...customToolSchemas];
    }

    async callTool(name, rawArguments) {
      const logger = createLogger(this._logBuffer, name);
      const startTime = Date.now();

      // Log tool invocation start (skip logging for read_log to avoid recursion)
      if (name !== 'read_log') {
        logger.info(`Tool "${name}" started`, {
          arguments: this._sanitizeArguments(rawArguments),
        });
      }

      // Check if this is a custom tool
      const customTool = this._customTools.find(tool => tool.schema.name === name);

      if (customTool) {
        const parsedArguments = customTool.schema.inputSchema.parse(rawArguments || {});
        const context = this._context;
        const response = new Response(context, name, parsedArguments);

        response.logBegin();
        context.setRunningTool(name);

        try {
          await customTool.handle(context, parsedArguments, response);
          await response.finish();
          if (this._sessionLog) {
            this._sessionLog.logResponse(response);
          }

          // Log success
          if (name !== 'read_log') {
            const duration = Date.now() - startTime;
            logger.info(`Tool "${name}" completed`, { durationMs: duration });
          }
        } catch (error) {
          response.addError(String(error));

          // Log error
          if (name !== 'read_log') {
            const duration = Date.now() - startTime;
            logger.error(`Tool "${name}" failed: ${error.message}`, {
              durationMs: duration,
              error: error.message,
              stack: error.stack,
            });
          }
        } finally {
          context.setRunningTool(undefined);
        }

        response.logEnd();
        const _meta = rawArguments?._meta;
        return response.serialize({ _meta });
      }

      // Delegate to base implementation for standard tools
      try {
        const result = await super.callTool(name, rawArguments);

        // Log success for standard tools
        if (name !== 'read_log') {
          const duration = Date.now() - startTime;
          const isError = result?.isError;
          if (isError) {
            logger.error(`Tool "${name}" failed`, { durationMs: duration });
          } else {
            logger.info(`Tool "${name}" completed`, { durationMs: duration });
          }
        }

        return result;
      } catch (error) {
        // Log error for standard tools
        if (name !== 'read_log') {
          const duration = Date.now() - startTime;
          logger.error(`Tool "${name}" failed: ${error.message}`, {
            durationMs: duration,
            error: error.message,
            stack: error.stack,
          });
        }
        throw error;
      }
    }

    /**
     * Sanitize arguments for logging (remove sensitive data from logs)
     */
    _sanitizeArguments(args) {
      if (!args) return {};
      const sanitized = { ...args };
      // Remove _meta from logged arguments
      delete sanitized._meta;
      return sanitized;
    }

    serverClosed() {
      const logger = createLogger(this._logBuffer, 'mcp_server');
      logger.info('MCP session closed');
      super.serverClosed();
    }
  };
}

/**
 * Patches the Playwright MCP module to include custom tools.
 * Call this before starting the MCP server.
 *
 * @returns {{ PatchedBrowserServerBackend: any, customTools: any[] }}
 */
function patchPlaywrightMcp() {
  const playwrightPath = path.dirname(require.resolve('playwright/package.json'));
  const { BrowserServerBackend } = require(path.join(playwrightPath, 'lib/mcp/browser/browserServerBackend.js'));

  const PatchedBrowserServerBackend = createPatchedBackend(BrowserServerBackend);

  return {
    PatchedBrowserServerBackend,
    customTools
  };
}

/**
 * Creates a patched factory that uses the patched backend
 *
 * @param {object} config - MCP configuration
 * @param {object} browserContextFactory - Browser context factory
 * @returns {object} - Server backend instance
 */
function createPatchedServerBackend(config, browserContextFactory) {
  const { PatchedBrowserServerBackend } = patchPlaywrightMcp();
  return new PatchedBrowserServerBackend(config, browserContextFactory);
}

module.exports = {
  createPatchedBackend,
  patchPlaywrightMcp,
  createPatchedServerBackend,
  customTools
};
