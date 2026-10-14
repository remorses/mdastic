import { defineConfig } from 'vitest/config'

// The oracle must run micromark's production build. Vitest picks the `development` export
// condition otherwise, whose devlop assertions throw on inputs the published build handles
// (e.g. misnested JSX inside link labels).
process.env.NODE_ENV = 'production'

export default defineConfig({
  test: { testTimeout: 120_000 },
})
