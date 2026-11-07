import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import url from 'node:url'

const here = path.dirname(url.fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    // 规则引擎与卡牌库住在上一层的 engine/ 里（JS 版原样复用，不复制一份）
    fs: { allow: [root] },
  },
  resolve: {
    alias: {
      '@engine': path.resolve(root, 'engine/src'),
      '@cards': path.resolve(root, 'engine/cards'),
      '@data': path.resolve(root, 'data'),
      '@app': path.resolve(root, 'app/js'),
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
})
