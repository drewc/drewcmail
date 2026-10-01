import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { cssShadowDOM } from './packages/@spinal/shadow-css/index.ts'

// `pnpm dev` proxies the API to the server — in podman (`pnpm podman:run`) or `pnpm server`
const API = process.env.MAIL_API ?? 'http://127.0.0.1:8025'

export default defineConfig(({ command }) => ({
  // container/dev.sh's Vite shares node_modules with the host's: its own cache, or each invalidates the other's
  cacheDir: process.env.VITE_CACHE_DIR ?? 'node_modules/.vite',
  server: {
    proxy: { '/api': { target: API, changeOrigin: true } },
    // the server is not part of the page (container/dev-server.ts restarts it)
    watch: { ignored: ['**/server/**', '**/container/**'] },
  },
  // editor.html: the compose body's frame (src/editor/main.ts)
  build: { rolldownOptions: { input: { main: 'index.html', editor: 'editor.html' } } },
  plugins: [
    tailwindcss(),
    cssShadowDOM({ command }),
  ],
}))
