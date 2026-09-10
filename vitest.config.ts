import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { conditions: ['development'] },
  test: { include: ['tests/**/*.test.ts'] },
})
