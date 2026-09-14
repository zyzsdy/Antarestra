import { defineConfig } from 'vite'
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'public',
    lib: { entry: 'client/index.ts', formats: ['es'], fileName: () => 'index.js' },
  },
})
