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
 * CSS to disable all animations and transitions
 */
const DISABLE_ANIMATIONS_CSS = `
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  scroll-behavior: auto !important;
}
`;

/**
 * Resolves the target URL from provided parameters
 */
function resolveUrl(params) {
  if (params.url) {
    return params.url;
  }

  const baseUrl = params.baseUrl || process.env.BASE_URL;
  if (!baseUrl) {
    throw new Error('Either url or baseUrl (or BASE_URL env var) must be provided');
  }

  const path = params.path || '/';
  // Ensure proper URL joining
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const normalizedPath = path.startsWith('/') ? path : '/' + path;

  return base + normalizedPath;
}

/**
 * Apply authentication before navigation
 */
async function applyAuth(context, browserContext, page, params, codeLines, warnings) {
  const auth = params.auth;
  if (!auth || auth.mode === 'none') {
    return;
  }

  switch (auth.mode) {
    case 'storageState': {
      if (params.storageState) {
        // Apply storage state to context - this sets cookies and localStorage
        await browserContext.addCookies(params.storageState.cookies || []);
        // Note: localStorage can't be set directly on context, must be done per-origin
        codeLines.push(`// Storage state applied from inline configuration`);
      }
      break;
    }

    case 'basic': {
      if (!auth.basic) {
        throw new Error('auth.basic configuration required when mode is "basic"');
      }
      // Set HTTP credentials on the context
      await browserContext.setHTTPCredentials({
        username: auth.basic.username,
        password: auth.basic.password
      });
      codeLines.push(`await context.setHTTPCredentials({ username: '${auth.basic.username}', password: '***' });`);
      break;
    }

    case 'token': {
      if (!auth.token) {
        throw new Error('auth.token configuration required when mode is "token"');
      }
      const headerName = auth.token.headerName || 'Authorization';
      const scheme = auth.token.scheme || 'Bearer';
      const headerValue = scheme ? `${scheme} ${auth.token.value}` : auth.token.value;

      // Merge with existing extra HTTP headers
      const headers = { ...(params.extraHTTPHeaders || {}), [headerName]: headerValue };
      await browserContext.setExtraHTTPHeaders(headers);
      codeLines.push(`await context.setExtraHTTPHeaders({ '${headerName}': '${scheme} ***' });`);
      break;
    }

    case 'uiLogin': {
      if (!auth.uiLogin) {
        throw new Error('auth.uiLogin configuration required when mode is "uiLogin"');
      }
      const loginConfig = auth.uiLogin;
      const loginUrl = loginConfig.loginUrl || params.url || resolveUrl(params);

      codeLines.push(`// Performing UI login flow`);
      codeLines.push(`await page.goto('${loginUrl}');`);
      await page.goto(loginUrl, { waitUntil: params.waitUntil || 'domcontentloaded' });

      // Fill username
      codeLines.push(`await page.locator('${loginConfig.usernameSelector}').fill('${loginConfig.username}');`);
      await page.locator(loginConfig.usernameSelector).fill(loginConfig.username);

      // Fill password
      codeLines.push(`await page.locator('${loginConfig.passwordSelector}').fill('***');`);
      await page.locator(loginConfig.passwordSelector).fill(loginConfig.password);

      // Submit
      codeLines.push(`await page.locator('${loginConfig.submitSelector}').click();`);
      await page.locator(loginConfig.submitSelector).click();

      // Wait for post-login indicator if specified
      if (loginConfig.postLoginSelector) {
        codeLines.push(`await page.locator('${loginConfig.postLoginSelector}').waitFor({ state: 'visible' });`);
        await page.locator(loginConfig.postLoginSelector).waitFor({ state: 'visible', timeout: params.ready?.timeoutMs || 30000 });
      } else {
        // Default: wait for navigation to complete
        codeLines.push(`await page.waitForLoadState('networkidle');`);
        await page.waitForLoadState('networkidle');
      }
      break;
    }

    default:
      warnings.push(`Unknown auth mode: ${auth.mode}`);
  }
}

/**
 * Set up resource blocking
 */
async function setupResourceBlocking(page, blockResources, codeLines) {
  if (!blockResources || blockResources.length === 0) {
    return;
  }

  const resourceTypes = new Set(blockResources);

  codeLines.push(`await page.route('**/*', route => {`);
  codeLines.push(`  const resourceType = route.request().resourceType();`);
  codeLines.push(`  if (${JSON.stringify(blockResources)}.includes(resourceType)) {`);
  codeLines.push(`    route.abort();`);
  codeLines.push(`  } else {`);
  codeLines.push(`    route.continue();`);
  codeLines.push(`  }`);
  codeLines.push(`});`);

  await page.route('**/*', route => {
    const resourceType = route.request().resourceType();
    if (resourceTypes.has(resourceType)) {
      return route.abort();
    }
    return route.continue();
  });
}

/**
 * Wait for page readiness based on ready conditions
 */
async function waitForReady(page, ready, codeLines) {
  if (!ready) {
    return 0;
  }

  const startTime = Date.now();
  const timeout = ready.timeoutMs || 30000;

  // Wait for selector to be visible
  if (ready.selector) {
    codeLines.push(`await page.locator('${ready.selector}').waitFor({ state: 'visible', timeout: ${timeout} });`);
    await page.locator(ready.selector).waitFor({ state: 'visible', timeout });
  }

  // Wait for spinner/loading to disappear
  if (ready.noSpinnerSelector) {
    codeLines.push(`await page.locator('${ready.noSpinnerSelector}').waitFor({ state: 'hidden', timeout: ${timeout} });`);
    await page.locator(ready.noSpinnerSelector).waitFor({ state: 'hidden', timeout });
  }

  // Wait for JS condition
  if (ready.jsCondition) {
    codeLines.push(`await page.waitForFunction(() => ${ready.jsCondition}, { timeout: ${timeout} });`);
    // Create a function string that will be evaluated in browser context
    const conditionFn = new Function(`return (${ready.jsCondition})`);
    await page.waitForFunction(conditionFn, { timeout });
  }

  return Date.now() - startTime;
}

/**
 * setup-page tool definition
 */
const setupPage = defineTool({
  capability: 'core',

  schema: {
    name: 'browser_setup_page',
    title: 'Setup page for testing',
    description: 'Prepares a Playwright page into a predictable "ready-to-test" state. Navigates to URL, handles authentication, waits for readiness, and configures the page for testing.',

    inputSchema: z.object({
      // URL Resolution
      url: z.string().optional().describe('Full URL to navigate to'),
      baseUrl: z.string().optional().describe('Base URL, uses env BASE_URL if not provided'),
      path: z.string().optional().describe('URL path appended to baseUrl (default "/")'),

      // Navigation
      waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).optional()
        .describe('When to consider navigation complete (default "domcontentloaded")'),

      // Readiness conditions
      ready: z.object({
        selector: z.string().optional().describe('CSS selector to wait for (visible)'),
        noSpinnerSelector: z.string().optional().describe('CSS selector for spinner/loader to wait until hidden'),
        jsCondition: z.string().optional().describe('JavaScript expression returning boolean to poll'),
        timeoutMs: z.number().optional().describe('Timeout in milliseconds (default 30000)')
      }).optional().describe('Conditions to wait for page readiness'),

      // Viewport and emulation
      viewport: z.object({
        width: z.number().describe('Viewport width in pixels'),
        height: z.number().describe('Viewport height in pixels')
      }).optional().describe('Browser viewport size (default {width: 1280, height: 720})'),

      locale: z.string().optional().describe('Browser locale, e.g., "en-US"'),
      timezoneId: z.string().optional().describe('Timezone ID, e.g., "America/New_York"'),
      userAgent: z.string().optional().describe('Custom user agent string'),
      colorScheme: z.enum(['light', 'dark', 'no-preference']).optional()
        .describe('Preferred color scheme'),

      // Headers and cookies
      extraHTTPHeaders: z.record(z.string()).optional()
        .describe('Extra HTTP headers to send with every request'),
      cookies: z.array(z.object({
        name: z.string(),
        value: z.string(),
        domain: z.string().optional(),
        path: z.string().optional(),
        expires: z.number().optional(),
        httpOnly: z.boolean().optional(),
        secure: z.boolean().optional(),
        sameSite: z.enum(['Strict', 'Lax', 'None']).optional()
      })).optional().describe('Cookies to set before navigation'),

      // Storage state
      storageState: z.object({
        cookies: z.array(z.any()).optional(),
        origins: z.array(z.any()).optional()
      }).optional().describe('Storage state (cookies and localStorage) to apply'),

      // Authentication
      auth: z.object({
        mode: z.enum(['none', 'storageState', 'basic', 'token', 'uiLogin'])
          .describe('Authentication mode'),
        basic: z.object({
          username: z.string(),
          password: z.string()
        }).optional().describe('Basic auth credentials'),
        token: z.object({
          headerName: z.string().optional().describe('Header name (default "Authorization")'),
          value: z.string().describe('Token value'),
          scheme: z.string().optional().describe('Token scheme (default "Bearer")')
        }).optional().describe('Token-based auth configuration'),
        uiLogin: z.object({
          usernameSelector: z.string().describe('Selector for username input'),
          passwordSelector: z.string().describe('Selector for password input'),
          submitSelector: z.string().describe('Selector for submit button'),
          username: z.string().describe('Username to enter'),
          password: z.string().describe('Password to enter'),
          postLoginSelector: z.string().optional()
            .describe('Selector to wait for after login success'),
          loginUrl: z.string().optional()
            .describe('URL of login page (uses target URL if not specified)')
        }).optional().describe('UI-based login configuration')
      }).optional().describe('Authentication configuration'),

      // Page configuration
      disableAnimations: z.boolean().optional()
        .describe('Inject CSS to disable animations (default true)'),
      blockResources: z.array(z.string()).optional()
        .describe('Resource types to block, e.g., ["image", "font"]'),
      permissions: z.array(z.string()).optional()
        .describe('Browser permissions to grant, e.g., ["geolocation"]'),
      geolocation: z.object({
        latitude: z.number(),
        longitude: z.number(),
        accuracy: z.number().optional()
      }).optional().describe('Geolocation to emulate')
    }),

    type: 'action'
  },

  handle: async (context, params, response) => {
    const startTime = Date.now();
    const warnings = [];
    const codeLines = [];

    try {
      // Get or create browser context and page
      const browserContext = await context.ensureBrowserContext();
      const tab = await context.ensureTab();
      const page = tab.page;

      // Apply viewport
      const viewport = params.viewport || { width: 1280, height: 720 };
      codeLines.push(`await page.setViewportSize({ width: ${viewport.width}, height: ${viewport.height} });`);
      await page.setViewportSize(viewport);

      // Apply context-level settings
      if (params.extraHTTPHeaders && (!params.auth || params.auth.mode !== 'token')) {
        codeLines.push(`await context.setExtraHTTPHeaders(${JSON.stringify(params.extraHTTPHeaders)});`);
        await browserContext.setExtraHTTPHeaders(params.extraHTTPHeaders);
      }

      if (params.geolocation) {
        codeLines.push(`await context.setGeolocation(${JSON.stringify(params.geolocation)});`);
        await browserContext.setGeolocation(params.geolocation);
      }

      if (params.permissions && params.permissions.length > 0) {
        const targetUrl = resolveUrl(params);
        const origin = new URL(targetUrl).origin;
        codeLines.push(`await context.grantPermissions(${JSON.stringify(params.permissions)}, { origin: '${origin}' });`);
        await browserContext.grantPermissions(params.permissions, { origin });
      }

      // Apply cookies before navigation
      if (params.cookies && params.cookies.length > 0) {
        codeLines.push(`await context.addCookies(${JSON.stringify(params.cookies)});`);
        await browserContext.addCookies(params.cookies);
      }

      // Apply storage state cookies
      if (params.storageState?.cookies) {
        codeLines.push(`await context.addCookies(/* storageState cookies */);`);
        await browserContext.addCookies(params.storageState.cookies);
      }

      // Handle authentication
      await applyAuth(context, browserContext, page, params, codeLines, warnings);

      // Set up resource blocking (before navigation)
      await setupResourceBlocking(page, params.blockResources, codeLines);

      // Determine target URL
      const targetUrl = resolveUrl(params);
      const waitUntil = params.waitUntil || 'domcontentloaded';

      // Navigate (skip if UI login already navigated to correct page)
      const navigationStart = Date.now();
      if (!params.auth || params.auth.mode !== 'uiLogin') {
        codeLines.push(`await page.goto('${targetUrl}', { waitUntil: '${waitUntil}' });`);
        await page.goto(targetUrl, { waitUntil });
      } else if (page.url() !== targetUrl) {
        // After UI login, navigate to target if different
        codeLines.push(`await page.goto('${targetUrl}', { waitUntil: '${waitUntil}' });`);
        await page.goto(targetUrl, { waitUntil });
      }
      const navigationMs = Date.now() - navigationStart;

      // Apply post-navigation settings

      // Disable animations (default true)
      const shouldDisableAnimations = params.disableAnimations !== false;
      if (shouldDisableAnimations) {
        codeLines.push(`await page.addStyleTag({ content: /* disable animations CSS */ });`);
        await page.addStyleTag({ content: DISABLE_ANIMATIONS_CSS });
      }

      // Apply color scheme
      if (params.colorScheme) {
        codeLines.push(`await page.emulateMedia({ colorScheme: '${params.colorScheme}' });`);
        await page.emulateMedia({ colorScheme: params.colorScheme });
      }

      // Wait for readiness conditions
      const readyMs = await waitForReady(page, params.ready, codeLines);

      // Capture final state
      const finalUrl = page.url();
      const title = await page.title();
      const totalMs = Date.now() - startTime;

      // Build result
      const result = {
        ok: true,
        url: finalUrl,
        title,
        timings: {
          navigationMs,
          readyMs,
          totalMs
        }
      };

      if (warnings.length > 0) {
        result.warnings = warnings;
      }

      // Add code to response
      for (const line of codeLines) {
        response.addCode(line);
      }

      // Format result output
      response.addResult(`Page setup complete:
- URL: ${finalUrl}
- Title: ${title}
- Navigation: ${navigationMs}ms
- Ready wait: ${readyMs}ms
- Total: ${totalMs}ms${warnings.length > 0 ? '\n- Warnings: ' + warnings.join(', ') : ''}`);

      response.setIncludeSnapshot();

    } catch (error) {
      const totalMs = Date.now() - startTime;

      // Add any code that was generated before the error
      for (const line of codeLines) {
        response.addCode(line);
      }

      response.addError(`Setup page failed after ${totalMs}ms: ${error.message}`);
    }
  }
});

module.exports = [setupPage];
