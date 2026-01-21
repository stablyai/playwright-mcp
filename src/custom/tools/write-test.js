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
const fs = require('fs');

// Get path to playwright internals (not exported via package.json exports)
const playwrightCorePath = path.dirname(require.resolve('playwright-core/package.json'));
const playwrightPath = path.dirname(require.resolve('playwright/package.json'));

const { z } = require(path.join(playwrightCorePath, 'lib/mcpBundle'));
const { defineTool } = require(path.join(playwrightPath, 'lib/mcp/browser/tools/tool'));

const { createLogger } = require('../log-buffer');

/**
 * Validates that a file path is within the project root and doesn't escape it
 * @param {string} filePath - The file path to validate
 * @param {string} rootPath - The project root path
 * @returns {boolean} True if path is safe
 */
function isPathWithinRoot(filePath, rootPath) {
  const resolvedPath = path.resolve(rootPath, filePath);
  const normalizedRoot = path.resolve(rootPath);
  return resolvedPath.startsWith(normalizedRoot + path.sep) || resolvedPath === normalizedRoot;
}

/**
 * generator_write_test tool definition
 */
const writeTest = defineTool({
  capability: 'core',

  schema: {
    name: 'generator_write_test',
    title: 'Write generated test',
    description: 'Write the generated test code to a file. The file path must be relative to the project root and must not escape the project directory.',

    inputSchema: z.object({
      fileName: z.string()
        .describe('The file to write the test to (relative to project root)'),
      code: z.string()
        .describe('The generated test code'),
    }),

    type: 'action',
  },

  handle: async (context, params, response) => {
    const logBuffer = context._logBuffer;
    const logger = logBuffer ? createLogger(logBuffer, 'generator_write_test') : null;

    try {
      // Get root path from context
      const rootPath = context._rootPath || process.cwd();

      // Validate fileName is provided and not empty
      if (!params.fileName || params.fileName.trim() === '') {
        const error = 'fileName is required and cannot be empty';
        logger?.error(error);
        response.addError(error);
        return;
      }

      // Validate code is provided
      if (!params.code) {
        const error = 'code is required';
        logger?.error(error);
        response.addError(error);
        return;
      }

      // Normalize the file path
      const normalizedFileName = params.fileName.replace(/\\/g, '/');

      // Check for path traversal attempts
      if (normalizedFileName.includes('..')) {
        const error = 'Path traversal detected: fileName cannot contain ".."';
        logger?.error(error, { fileName: params.fileName });
        response.addError(error);
        return;
      }

      // Validate the path is within project root
      if (!isPathWithinRoot(normalizedFileName, rootPath)) {
        const error = `File path "${params.fileName}" is outside the project root`;
        logger?.error(error, { fileName: params.fileName, rootPath });
        response.addError(error);
        return;
      }

      // Calculate the absolute file path
      const absoluteFilePath = path.resolve(rootPath, normalizedFileName);

      // Create parent directories if needed
      const parentDir = path.dirname(absoluteFilePath);
      try {
        await fs.promises.mkdir(parentDir, { recursive: true });
        logger?.debug('Created parent directories', { parentDir });
      } catch (mkdirError) {
        const error = `Failed to create directory "${parentDir}": ${mkdirError.message}`;
        logger?.error(error, { parentDir, error: mkdirError.message });
        response.addError(error);
        return;
      }

      // Write the code to the file
      try {
        await fs.promises.writeFile(absoluteFilePath, params.code, 'utf8');
        logger?.info('Test file written successfully', {
          fileName: params.fileName,
          absolutePath: absoluteFilePath,
          codeLength: params.code.length,
        });
      } catch (writeError) {
        const error = `Failed to write file "${absoluteFilePath}": ${writeError.message}`;
        logger?.error(error, { absolutePath: absoluteFilePath, error: writeError.message });
        response.addError(error);
        return;
      }

      // Generate code that shows what was done
      response.addCode(`// Test file written to: ${normalizedFileName}`);
      response.addCode(`await fs.promises.writeFile('${normalizedFileName}', testCode);`);

      // Return success result
      response.addResult(`Test file written successfully:
- File: ${normalizedFileName}
- Absolute path: ${absoluteFilePath}
- Size: ${params.code.length} bytes`);

    } catch (error) {
      logger?.error(`Unexpected error: ${error.message}`, { error: error.message, stack: error.stack });
      response.addError(`Failed to write test file: ${error.message}`);
    }
  },
});

module.exports = [writeTest];
