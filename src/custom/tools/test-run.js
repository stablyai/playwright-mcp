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

const { createLogger } = require('../log-buffer');

/**
 * Default timeout for test execution (5 minutes)
 */
const DEFAULT_TIMEOUT = 300000;

/**
 * Execute Playwright tests via npx playwright test
 * @param {object} params - Test parameters
 * @param {string[]} [params.locations] - Test file locations to run
 * @param {string[]} [params.projects] - Playwright project names
 * @param {number} [params.timeout] - Maximum time in ms
 * @param {boolean} [params.headed] - Run in headed mode
 * @param {number} [params.workers] - Number of parallel workers
 * @param {string} cwd - Working directory
 * @returns {Promise<{exitCode: number, output: string, timedOut: boolean}>}
 */
async function runTests(params, cwd, timeout = DEFAULT_TIMEOUT) {
  const args = ['playwright', 'test'];

  // Add test locations
  if (params.locations && params.locations.length > 0) {
    args.push(...params.locations);
  }

  // Add project filters
  if (params.projects && params.projects.length > 0) {
    params.projects.forEach(p => args.push('--project', p));
  }

  // Add headed mode flag
  if (params.headed) {
    args.push('--headed');
  }

  // Add workers configuration
  if (params.workers !== undefined && params.workers !== null) {
    args.push('--workers', String(params.workers));
  }

  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;

    const proc = spawn('npx', args, {
      cwd,
      env: { ...process.env, FORCE_COLOR: '0' },
      shell: process.platform === 'win32'
    });

    // Set up timeout if specified
    const timer = timeout > 0 ? setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      // Force kill after 5 seconds if process doesn't terminate
      setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // Process may already be dead
        }
      }, 5000);
    }, timeout) : null;

    proc.stdout.on('data', (data) => {
      output += data.toString();
    });

    proc.stderr.on('data', (data) => {
      output += data.toString();
    });

    proc.on('error', (error) => {
      if (timer) clearTimeout(timer);
      resolve({
        exitCode: 1,
        output: output + '\nProcess error: ' + error.message,
        timedOut: false
      });
    });

    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        exitCode: timedOut ? -1 : (code ?? 1),
        output,
        timedOut
      });
    });
  });
}

/**
 * Parse test output to extract summary statistics
 * @param {string} output - Test output
 * @returns {{passed: number, failed: number, skipped: number, total: number} | null}
 */
function parseTestResults(output) {
  // Match patterns like "2 passed", "1 failed", "3 skipped"
  const passedMatch = output.match(/(\d+)\s+passed/);
  const failedMatch = output.match(/(\d+)\s+failed/);
  const skippedMatch = output.match(/(\d+)\s+skipped/);

  const passed = passedMatch ? parseInt(passedMatch[1], 10) : 0;
  const failed = failedMatch ? parseInt(failedMatch[1], 10) : 0;
  const skipped = skippedMatch ? parseInt(skippedMatch[1], 10) : 0;

  // If no results were found, return null
  if (!passedMatch && !failedMatch && !skippedMatch) {
    return null;
  }

  return {
    passed,
    failed,
    skipped,
    total: passed + failed + skipped
  };
}

/**
 * test_run tool definition
 */
const testRun = defineTool({
  capability: 'core',

  schema: {
    name: 'test_run',
    title: 'Run Playwright tests',
    description: 'Execute Playwright tests and return the results. Spawns npx playwright test with appropriate arguments.',

    inputSchema: z.object({
      locations: z.array(z.string()).optional()
        .describe('Test file locations to run: "tests/e2e" or "tests/e2e/login.spec.ts" or "tests/e2e/login.spec.ts:20"'),
      projects: z.array(z.string()).optional()
        .describe('Playwright project names to run (e.g., "chromium", "firefox"). Runs all projects by default.'),
      timeout: z.number().optional()
        .describe('Maximum time in milliseconds to wait for tests to complete (default 300000 = 5 minutes)'),
      headed: z.boolean().optional()
        .describe('Run tests in headed browser mode (default false)'),
      workers: z.number().optional()
        .describe('Number of parallel workers to run tests (default: uses playwright config)')
    }),

    type: 'readOnly'
  },

  handle: async (context, params, response) => {
    const startTime = Date.now();
    const logger = context._logBuffer ? createLogger(context._logBuffer, 'test_run') : null;

    // Determine working directory
    const cwd = process.cwd();
    const timeout = params.timeout ?? DEFAULT_TIMEOUT;

    // Log start
    if (logger) {
      logger.info('Starting test execution', {
        locations: params.locations,
        projects: params.projects,
        timeout,
        headed: params.headed,
        workers: params.workers,
        cwd
      });
    }

    try {
      // Run the tests
      const result = await runTests(params, cwd, timeout);
      const duration = Date.now() - startTime;

      // Parse results summary
      const summary = parseTestResults(result.output);

      // Build result output
      let resultText = '';

      if (result.timedOut) {
        resultText += `Test execution timed out after ${timeout}ms\n\n`;
        if (logger) {
          logger.warn('Test execution timed out', { timeoutMs: timeout, durationMs: duration });
        }
      }

      // Add summary if available
      if (summary) {
        resultText += `## Test Summary\n`;
        resultText += `- Passed: ${summary.passed}\n`;
        resultText += `- Failed: ${summary.failed}\n`;
        resultText += `- Skipped: ${summary.skipped}\n`;
        resultText += `- Total: ${summary.total}\n`;
        resultText += `- Duration: ${duration}ms\n`;
        resultText += `- Exit Code: ${result.exitCode}\n\n`;
      } else {
        resultText += `## Execution Info\n`;
        resultText += `- Duration: ${duration}ms\n`;
        resultText += `- Exit Code: ${result.exitCode}\n\n`;
      }

      resultText += `## Test Output\n\`\`\`\n${result.output}\n\`\`\``;

      // Log completion
      if (logger) {
        if (result.exitCode === 0) {
          logger.info('Test execution completed successfully', {
            durationMs: duration,
            summary
          });
        } else if (!result.timedOut) {
          logger.warn('Test execution completed with failures', {
            durationMs: duration,
            exitCode: result.exitCode,
            summary
          });
        }
      }

      // Set error state if tests failed
      if (result.exitCode !== 0) {
        response.addError(resultText);
      } else {
        response.addResult(resultText);
      }

    } catch (error) {
      const duration = Date.now() - startTime;

      if (logger) {
        logger.error('Test execution failed', {
          error: error.message,
          stack: error.stack,
          durationMs: duration
        });
      }

      response.addError(`Test execution failed after ${duration}ms: ${error.message}`);
    }
  }
});

module.exports = [testRun];
