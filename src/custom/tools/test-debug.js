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
const { spawn } = require('child_process');

// Get path to playwright internals (not exported via package.json exports)
const playwrightCorePath = path.dirname(require.resolve('playwright-core/package.json'));
const playwrightPath = path.dirname(require.resolve('playwright/package.json'));

const { z } = require(path.join(playwrightCorePath, 'lib/mcpBundle'));
const { defineTool } = require(path.join(playwrightPath, 'lib/mcp/browser/tools/tool'));

/**
 * Runs a single Playwright test in debug mode.
 * @param {string} testId - The test ID to run
 * @param {string} cwd - Working directory for the test
 * @returns {Promise<{output: string, status: string, exitCode: number}>}
 */
function runDebugTest(testId, cwd) {
  return new Promise((resolve) => {
    const args = [
      'playwright', 'test',
      '--headed',
      '--workers=1',
      '--timeout=0',
      '--grep', testId
    ];

    let output = '';
    const proc = spawn('npx', args, {
      cwd: cwd || process.cwd(),
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        PWDEBUG: '1'
      },
      shell: process.platform === 'win32'
    });

    proc.stdout.on('data', (data) => {
      output += data.toString();
    });

    proc.stderr.on('data', (data) => {
      output += data.toString();
    });

    proc.on('close', (code) => {
      let status;
      if (code === 0) {
        status = 'passed';
      } else if (output.includes('paused')) {
        status = 'paused';
      } else {
        status = 'failed';
      }
      resolve({ output, status, exitCode: code });
    });

    proc.on('error', (err) => {
      output += `Error spawning process: ${err.message}`;
      resolve({ output, status: 'failed', exitCode: 1 });
    });
  });
}

/**
 * test_debug tool definition
 * Debug a single Playwright test by its ID. Runs in headed mode with pause-on-error.
 */
const testDebug = defineTool({
  capability: 'core',

  schema: {
    name: 'test_debug',
    title: 'Debug single test',
    description: 'Debug a single Playwright test by its ID. Runs in headed mode with pause-on-error.',

    inputSchema: z.object({
      test: z.object({
        id: z.string().describe('Test ID to debug (from test_list output)'),
        title: z.string().describe('Human readable test title')
      }).describe('Test to debug')
    }),

    type: 'readOnly'
  },

  handle: async (context, params, response) => {
    // Validate required parameters
    if (!params.test) {
      response.addError('test parameter is required');
      return;
    }

    if (!params.test.id) {
      response.addError('test.id is required');
      return;
    }

    if (!params.test.title) {
      response.addError('test.title is required');
      return;
    }

    try {
      const { output, status, exitCode } = await runDebugTest(params.test.id, process.cwd());

      // Build result message
      const resultMessage = [
        `Test: ${params.test.title}`,
        `Status: ${status}`,
        `Exit code: ${exitCode}`,
        '',
        'Output:',
        output
      ].join('\n');

      if (status === 'passed' || status === 'paused') {
        response.addResult(resultMessage);
      } else {
        response.addError(resultMessage);
      }
    } catch (error) {
      response.addError(`Failed to debug test: ${error.message}`);
    }
  }
});

module.exports = [testDebug];
