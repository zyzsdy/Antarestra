import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
export default defineConfig({ publicDir: false, plugins: [vue()], build: { outDir: 'public' } })
