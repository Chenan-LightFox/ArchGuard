import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const host = '127.0.0.1'
const proxy = { '/api': `http://${host}:${process.env.ARCHGUARD_API_PORT ?? 3001}` }

export default defineConfig({
  plugins: [react()],
  server: { host, port: 5173, strictPort: true, proxy },
  preview: { host, port: 4173, strictPort: true, proxy },
})
