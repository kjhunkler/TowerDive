# TowerDive

Isometric tower defense PWA (Vite + Three.js). See README.md for setup/dev commands.

## Workflow

- After any successful change, bump the version in `package.json` (`npm version patch`,
  or a manual edit for a larger bump) before committing, then push straight to `main`.
- The version is read from `package.json` at build time (`vite.config.js`) and exposed
  to the app as `__APP_VERSION__`. It's shown in the HUD on the home screen
  (`#hud-version` in `index.html`, set in `src/main.js`) and used as the Workbox
  `cacheId`, so each version gets a fresh precache and upgrading clients don't merge
  stale assets with new ones.
- `vite-plugin-pwa` is configured with `registerType: 'autoUpdate'`, so a deployed
  version bump is enough for installed/open PWA clients to pick up the new service
  worker and reload automatically — no manual cache-busting needed beyond bumping
  the version.
