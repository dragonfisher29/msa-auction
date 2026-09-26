import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.config';

// Runs only screenshots.spec.ts, which overwrites tracked docs/images/*.png.
// Selected explicitly via `npm run screenshots` -- never picked up by the
// default `npm run test:e2e` run (see the testIgnore in playwright.config.ts).
export default defineConfig(baseConfig, {
  testMatch: '**/screenshots.spec.ts',
  testIgnore: undefined,
});
