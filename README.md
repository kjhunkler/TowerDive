# TowerDive

An isometric tower defense PWA, built with [Three.js](https://threejs.org/) and [Vite](https://vitejs.dev/).

## Art assets

Models come from Kenney's [Tower Defense Kit](https://kenney.nl/assets/tower-defense-kit)
(CC0 license, see `public/assets/models/KENNEY_LICENSE.txt`) — glTF/GLB tiles,
towers, and enemies rendered with a fixed isometric camera.

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm run preview
```

The app is installable as a PWA (manifest + service worker via `vite-plugin-pwa`).
Replace `public/icons/icon-192.png` and `public/icons/icon-512.png` with real
artwork before shipping — they're solid-color placeholders for now.

## Deployment (GitHub Pages)

Hosted at `https://<owner>.github.io/TowerDive/`. `.github/workflows/deploy.yml`
builds with Vite and deploys to Pages on every push to `main`.

One-time setup: in the repo's **Settings → Pages**, set **Source** to
**GitHub Actions**. After that, pushes to `main` deploy automatically.

`vite.config.js` sets `base: '/TowerDive/'` to match the project-page URL — if
the repo is ever renamed, or moved to a custom domain / user root page
(`<owner>.github.io`), update `base` (and the PWA `start_url`/`scope`, which
derive from it) to match.
