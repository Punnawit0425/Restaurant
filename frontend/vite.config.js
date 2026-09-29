import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    // PWA: makes the app installable ("Add to Home Screen") on the shop's
    // phones/tablets and precaches the built assets so the shell loads fast.
    VitePWA({
      registerType: 'autoUpdate', // new deploys take effect on next open, no manual refresh
      includeAssets: ['apple-touch-icon.png'],
      manifest: {
        name: 'ตู้กับข้าวบ้านยาย & Siam Blend Bar',
        short_name: 'ตู้กับข้าวบ้านยาย',
        description: 'ระบบสั่งอาหารและจัดการร้าน ตู้กับข้าวบ้านยาย & Siam Blend Bar',
        lang: 'th',
        display: 'standalone', // full screen, no browser URL bar
        orientation: 'any', // allow both portrait and landscape; follow device rotation
        start_url: '/',
        theme_color: '#431407',
        background_color: '#431407',
        icons: [
          { src: '/pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Never cache API calls or menu photos — orders/stock must always be live.
        // (Requests not matched here fall through to the network as usual.)
        navigateFallbackDenylist: [/^\/api\//, /^\/uploads\//],
        runtimeCaching: [],
      },
    }),
  ],
  server: {
    // Listen on all interfaces (IPv4 + IPv6). Without this, Vite binds only to
    // IPv6 (::1) on Windows, so browsers that resolve "localhost" to the IPv4
    // 127.0.0.1 get "This site can't be reached".
    host: true,
    // Forward all "/api" calls (REST + the /api/events SSE stream) to the
    // backend running on port 3001. Keeps the frontend on plain relative URLs.
    // Use 127.0.0.1 (not "localhost") so the proxy doesn't hit the same
    // IPv6/IPv4 mismatch when reaching the backend.
    // "/uploads" (menu photos served off the backend's disk) is proxied for the
    // same reason: image_url holds a root-relative path, so an <img> pointing at
    // /uploads/xxx.jpg has to reach the backend rather than Vite's own root.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
      '/uploads': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
  // "vite preview" (serving the built dist/ for PWA testing) runs a separate
  // server that does NOT inherit server.proxy, so mirror the same settings.
  preview: {
    host: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
      '/uploads': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
})
