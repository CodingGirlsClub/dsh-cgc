import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts', 'test/**/*.spec.tsx'],
    // The panel family is browser-half heavy; host-half specs are DOM-free
    // and run unchanged under jsdom.
    environment: 'jsdom',
    testTimeout: 20000,
  },
})
