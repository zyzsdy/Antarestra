import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
export default defineConfig({
  server: { watch: { ignored: ['**/.tmp/**'] } },
  plugins: [
    vue(),
    {
      name: 'web-tools-preview',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (!req.url?.startsWith('/api/workspace-files/resources/')) return next()
          if (req.url.includes('/expired')) {
            res.writeHead(410).end()
            return
          }
          if (req.url.includes('/failure')) {
            res.writeHead(503).end()
            return
          }
          if (req.url.includes('/content')) {
            res.setHeader('content-type', 'image/svg+xml')
            res.end(
              '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><rect width="800" height="450" fill="#edf3ff"/><text x="50" y="100" font-size="40">网页截图预览</text><circle cx="200" cy="260" r="80" fill="#315ed1"/></svg>',
            )
          } else {
            res.setHeader('content-type', 'application/json')
            res.end('{}')
          }
        })
      },
    },
  ],
  resolve: { dedupe: ['vue'], conditions: ['development'] },
})
