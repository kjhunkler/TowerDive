import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)));

// GitHub Pages project site: served from https://<user>.github.io/TowerDive/
const base = '/TowerDive/';

export default defineConfig({
  base,
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        viewer: 'viewer.html',
        workshop: 'workshop.html',
      },
    },
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['assets/models/**/*.glb', 'assets/skyboxes/*.png'],
      manifest: {
        name: 'TowerDive',
        short_name: 'TowerDive',
        description: 'An isometric tower defense game',
        theme_color: '#1a1f2e',
        background_color: '#1a1f2e',
        display: 'standalone',
        start_url: base,
        scope: base,
        version,
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }
        ]
      },
      workbox: {
        // A new version changes this cache id, so upgrading clients drop
        // stale precaches instead of merging with the previous version's.
        cacheId: `towerdive-${version}`,
        globPatterns: ['**/*.{js,css,html,glb,png,svg}'],
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024
      }
    })
  ]
});
