import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setupTests.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/App.tsx', 'src/db/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.integration.test.ts'],
      thresholds: {
        statements: 62,
        branches: 58,
        functions: 52,
        lines: 62,
      },
    },
  },
})
