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
    }

    async listTools() {
      const baseTools = await super.listTools();
      const customToolSchemas = this._customTools.map(tool => toMcpTool(tool.schema));
      return [...baseTools, ...customToolSchemas];
    }

    async callTool(name, rawArguments) {
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
        } catch (error) {
          response.addError(String(error));
        } finally {
          context.setRunningTool(undefined);
        }

        response.logEnd();
        const _meta = rawArguments?._meta;
        return response.serialize({ _meta });
      }

      // Delegate to base implementation for standard tools
      return super.callTool(name, rawArguments);
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
