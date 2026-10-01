import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['turing.svg', 'push-handler.js'],
      manifest: {
        name: 'Turing Terminal',
        short_name: 'Turing',
        description: 'Control your local AI engineering workflows.',
        theme_color: '#0d1014',
        background_color: '#0d1014',
        display: 'standalone',
        start_url: '/',
        icons: [{ src: '/turing.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
      },
      workbox: {
        importScripts: ['/push-handler.js'],
        navigateFallback: '/index.html',
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/api/'),
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:4317',
    },
  },
  build: { outDir: 'dist' },
});
