import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    {
      // Mirror the wrangler.toml [[rules]] so tests can import src/index.ts:
      // .html/.txt/.svg load as strings and .png as an ArrayBuffer.
      name: 'wrangler-module-rules',
      enforce: 'pre',
      load(id) {
        const path = id.split('?')[0]
        if (/\.(html|txt|svg)$/.test(path)) {
          return `export default ${JSON.stringify(readFileSync(path, 'utf8'))}`
        }
        if (path.endsWith('.png')) return 'export default new ArrayBuffer(0)'
        return undefined
      },
    },
  ],
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
