import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
export default defineConfig({ publicDir: 'assets', plugins: [vue()], build: { outDir: 'public' } })
