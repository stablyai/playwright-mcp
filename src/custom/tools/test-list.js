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
 * Runs npx playwright test --list with the given arguments
 * @param {string[]} args - Arguments to pass to playwright test
 * @param {string} [cwd] - Working directory
 * @returns {Promise<{exitCode: number, output: string}>}
 */
async function runPlaywrightList(args, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['playwright', 'test', '--list', ...args], {
      cwd: cwd || process.cwd(),
      shell: process.platform === 'win32',
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', data => {
      stdout += data.toString();
    });

    proc.stderr.on('data', data => {
      stderr += data.toString();
    });

    proc.on('close', code => {
      resolve({
        exitCode: code || 0,
        output: stdout + stderr,
      });
    });

    proc.on('error', error => {
      reject(error);
    });
  });
}

/**
 * Parses the output of playwright test --list
 * @param {string} output - Raw output from playwright test --list
 * @returns {Array<{id: string, title: string, file: string, project?: string}>}
 */
function parseTestList(output) {
  const tests = [];
  const lines = output.split('\n');

  for (const line of lines) {
    // Skip empty lines and non-test lines
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Playwright --list output format is typically:
    // [project] › file.spec.ts:line:col › test title
    // or for tests without projects:
    // file.spec.ts:line:col › test title
    // Note: Playwright uses › (U+203A) not > (U+003E)

    // Match lines that contain test information
    // Use both › and > to be compatible with different versions
    const testMatch = trimmed.match(/^(?:\[([^\]]+)\]\s+[›>]\s+)?(.+?:\d+:\d+)\s+[›>]\s+(.+)$/);
    if (testMatch) {
      const [, project, location, title] = testMatch;
      tests.push({
        id: `${project ? `[${project}] ` : ''}${location} › ${title}`,
        title: title.trim(),
        file: location.split(':')[0],
        line: parseInt(location.split(':')[1], 10),
        column: parseInt(location.split(':')[2], 10),
        ...(project && { project }),
      });
    }
  }

  return tests;
}

/**
 * test_list tool definition
 */
const testList = defineTool({
  capability: 'core',

  schema: {
    name: 'test_list',
    title: 'List Playwright tests',
    description: 'Lists all available Playwright tests in the project without running them. Returns test IDs, titles, file locations, and project associations.',

    inputSchema: z.object({
      locations: z.array(z.string()).optional()
        .describe('File paths or test locations to filter'),
      projects: z.array(z.string()).optional()
        .describe('Project names to filter by'),
      grep: z.string().optional()
        .describe('Regex pattern to filter tests by title'),
      grepInvert: z.string().optional()
        .describe('Regex pattern to exclude tests by title'),
    }),

    type: 'readOnly',
  },

  handle: async (context, params, response) => {
    try {
      // Build command arguments
      const args = [];

      // Add location filters
      if (params.locations && params.locations.length > 0) {
        args.push(...params.locations);
      }

      // Add project filters
      if (params.projects && params.projects.length > 0) {
        for (const project of params.projects) {
          args.push('--project', project);
        }
      }

      // Add grep filter
      if (params.grep) {
        args.push('--grep', params.grep);
      }

      // Add grepInvert filter
      if (params.grepInvert) {
        args.push('--grep-invert', params.grepInvert);
      }

      // Run playwright test --list
      const result = await runPlaywrightList(args);

      if (result.exitCode !== 0) {
        // Check for common error patterns
        if (result.output.includes('No tests found')) {
          response.addResult(JSON.stringify({
            tests: [],
            count: 0,
            message: 'No tests found matching the specified criteria',
          }, null, 2));
          return;
        }

        response.addError(`Playwright test --list failed with exit code ${result.exitCode}:\n${result.output}`);
        return;
      }

      // Parse the output
      const tests = parseTestList(result.output);

      // Build response
      const output = {
        tests,
        count: tests.length,
      };

      response.addResult(JSON.stringify(output, null, 2));
    } catch (error) {
      response.addError(`Failed to list tests: ${error.message}`);
    }
  },
});

module.exports = [testList];
