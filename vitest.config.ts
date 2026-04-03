import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setupTests.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/lib/**/*.ts', 'src/db/**/*.ts', 'src/App.tsx'],
      exclude: ['src/**/*.test.ts', 'src/**/*.integration.test.ts'],
      thresholds: {
        statements: 70,
        branches: 55,
        functions: 75,
        lines: 70,
      },
    },
  },
})
