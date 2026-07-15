# TowerDive

An isometric tower defense PWA, built with [Three.js](https://threejs.org/) and [Vite](https://vitejs.dev/).

## Multiplayer

TowerDive has serverless P2P multiplayer built on [trystero](https://github.com/dmotz/trystero):
browsers connect directly over WebRTC data channels, using public Nostr relays
only for signaling and room discovery — GitHub Pages stays the only host.

- **Home menu** — pick a name, then Create New Map, Load Saved Map, Host, or Join.
- **Global presence** — hosts announce themselves in a shared lobby room; the
  menu lists live sessions with player counts and offers one-click Auto Join.
- **Hosting** — starts in the workshop with your saved map; everyone who joins
  receives the map and edits it simultaneously (edits replicate as small
  operations; undo is disabled in multiplayer since whole-map snapshots would
  revert other players' work).
- **Explore together** — at any point players can walk the map in first person
  and see each other. Netcode follows the standard FPS recipe: local movement
  is fully client-predicted, peers broadcast 20 Hz state snapshots, and remote
  players render ~120 ms in the past via snapshot interpolation (with brief
  extrapolation on packet loss), so motion stays smooth on real-world
  connections. Shots replicate as tracer/impact events.

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
