# Eagle Animation — CLAUDE.md

Stop motion animation software by Brick à Brack, available as an **Electron desktop app**, a **pure-browser web app** and an **Android app** (WebView shell), all sharing the same React renderer.

---

## This fork (`bontrager-dev/eagle-animation-simple-audio-dub`)

A private fork that adds an **audio dubbing mode**: a full-screen view where a child records voice and sound while stepping through the frames, which sets each frame's timing at the same time. The owner's son captures in Eagle Animation and mostly runs the **Electron app** (Windows and Linux). A standalone Python prototype of the same idea lives in `bontrager-dev/stop-motion-scrubber`; it is a separate project.

### Hard rule: never write to the official repo

`brick-a-brack/eagle-animation` is **read-only** for every session: no pushes, PRs, issues, comments or reviews, ever. A PR upstream is undecided and only the owner opens it. Fetch upstream by URL; this clone deliberately has no `upstream` remote that could be pushed to by mistake:

```bash
git fetch https://github.com/brick-a-brack/eagle-animation +refs/heads/dev:refs/remotes/upstream/dev +refs/heads/master:refs/remotes/upstream/master
```

### Branches

| Branch | What it is |
|---|---|
| `master` | Untouched copy of upstream `master`. |
| `develop` | Untouched copy of upstream `dev` (upstream takes PRs into `dev`). May lag upstream by a few dependency bumps; to sync, fast-forward it to `upstream/dev` and push to `origin`. |
| `audio-dub` | **The fork's main branch**: the dubbing feature and hardening on top of `master`. This is what the owner builds and runs. |
| `audio-dub-develop` | The same commits replayed onto `develop`, kept ready for a possible upstream PR into `dev`. |

Every change goes to **both** `audio-dub` and `audio-dub-develop`: commit on one, `git cherry-pick` onto the other. The branches have different lockfiles (`master` vs `dev` dependencies, e.g. posthog-js and electron-vite versions), so run `npm ci` after switching before you build or test. If a fresh clone only has one branch, run `git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*' && git fetch origin`.

This "This fork" section, and the fork-only notes below, should be dropped from any upstream PR.

---

## Stack

| Layer | Tool |
|---|---|
| Frontend | React 19, React Router 7, CSS Modules, i18next |
| Build (Electron) | electron-vite, Electron 44 |
| Build (web) | Vite 8 |
| Storage (Electron) | Node.js filesystem (see Storage layout) |
| Storage (web) | Dexie / IndexedDB |
| Image processing (Electron) | Sharp |
| Image processing (web) | OffscreenCanvas in Service Worker |
| Video export (Electron) | ffmpeg-static (native child process) |
| Video export (web) | @ffmpeg/ffmpeg (WASM), or WebCodecs via mediabunny |
| Android | Kotlin WebView shell with its own native backend (`android/`) |
| Camera | Toucan Camera Server (subprocess on Electron, env-var URL on web) |

---

## Project structure

```
src/
├── config.js            # Shared constants (DIRECTORY_NAME, MAX_FRAME_DUPLICATION …)
├── backend-electron/    # Electron main process (Node.js only)
│   ├── index.js         # Window creation, protocol registration, link/navigation guards, script blocker
│   ├── config.js        # PROJECTS_PATH, RESIZER_CACHE_PATH
│   ├── actions.js       # IPC action handlers
│   ├── core/
│   │   ├── paths.js     # [fork] Validation of every id/name the renderer sends
│   │   ├── routes.js    # ea:// custom protocol handler (image serving + resizing)
│   │   ├── projects.js  # Filesystem project I/O (frames and audio takes)
│   │   ├── export.js    # Native FFmpeg export
│   │   ├── discord.js   # Discord activity (only connected while the setting is on)
│   │   ├── utils.js     # Dialogs, openWebLink
│   │   ├── toucan.js    # Toucan Camera Server subprocess
│   │   └── settings.js  # Settings persistence (settings.json in PROJECTS_PATH)
│   └── preload/
│       └── index.js     # Exposes window.IPC to renderer via contextBridge
├── backend-web/         # Web browser backend (no server required)
│   ├── sw-web.js        # Service Worker — intercepts /api/pictures/* (compiled to /sw.js)
│   └── actions/
│       ├── index.js     # Web action handlers (exported as `Actions`) + event bus
│       ├── projects.js  # Dexie project CRUD
│       ├── frames.js    # IndexedDB blob storage (frames and audio takes)
│       ├── buffer.js    # Temporary buffer for exports
│       ├── ffmpeg.js    # FFmpeg.wasm export
│       └── webcodecs.js # WebCodecs export (mediabunny)
├── renderer/            # React app (shared by all platforms)
│   ├── index.jsx        # Entry: mounts React, PostHog (opt-in only), registers SW
│   ├── config.js        # Runtime device detection (ELECTRON / WEB / ANDROID)
│   ├── core/
│   │   ├── bindings.js  # THE bridge: EA() and EAEvents() multi-backend shim
│   │   ├── dubbing.js   # [fork] Take → frame lengths/audio slices; mixing
│   │   ├── dubAudio.js  # [fork] Mic capture (AudioWorklet), playback, export audio render
│   │   ├── dubInput.js  # [fork] Keyboard, gamepad, trigger scrubbing, hold-to-step
│   │   └── wav.js       # [fork] Mono 16-bit WAV encode/decode
│   ├── hooks/           # useProject, useProjects, useSettings, useDiscordActivity …
│   ├── views/           # Page components (Home, Animator, Export, Settings …)
│   └── components/      # Reusable UI components (DubbingWindow is the fork's view)
└── common/              # Shared between main and renderer
    ├── ffmpeg.js        # FFmpeg argument builders (codec, bitrate, audio track)
    └── resizer.js       # Query-param parsing for image resize requests
android/                 # Native Android shell; actions in .../actions/ActionDispatcher.kt
```

---

## The multi-backend bridge (`window.EA` / `EAEvents`)

**This is the most important architectural concept in the codebase.**

`src/renderer/core/bindings.js` exposes two functions that all hooks and components use to talk to the backend. It switches at runtime on whether `window.IPC` exists: the Electron preload and the Android shell inject it, the web app has none.

### `EA(action, data)` — request/response

```js
// Electron / Android: window.IPC exists
window.IPC.call(action, data)
  → Electron: ipcRenderer.invoke → src/backend-electron/actions.js handler
  → Android:  AndroidIPC bridge → ActionDispatcher.kt

// Web: lazy-loaded in-process handlers
import('../../backend-web/actions').then(({ Actions }) => Actions[action](null, data))
  → src/backend-web/actions/index.js handler
```

### `EAEvents(name, callback)` — event stream

```js
// Electron: wraps ipcRenderer.on
window.IPC.stream(name, callback)
  → mainWindow.webContents.send(name, value) from main process

// Web: in-memory event bus in src/backend-web/actions/index.js
addEventListener(name, callback)  // registers in module-level array
sendEvent(name, data)             // dispatches to all registered callbacks
```

### Device detection and capabilities

```js
// src/renderer/config.js — the Android shell sets window.DEVICE = 'ANDROID'
export const DEVICE = window.DEVICE || (window.IPC ? 'ELECTRON' : 'WEB');
```

Use `DEVICE` (not `import.meta.env`) anywhere runtime behavior must differ. Optional features are gated on the backend's `APP_CAPABILITIES` list (`useAppCapabilities`), e.g. `AUDIO_DUBBING` and `DISCORD`.

---

## Electron — custom `ea://` protocol

On Electron, images are never served over `file://` (CORS, permissions). Instead a custom protocol is registered in `src/backend-electron/index.js`:

```js
protocol.registerSchemesAsPrivileged([{ scheme: 'ea', privileges: { ... } }]);
protocol.handle('ea', ImageRoute);
```

**Handler — `src/backend-electron/core/routes.js`:**

URL format: `ea://api/pictures/{projectId}/{sceneIndex}/{filename}?w=800&h=600&f=webp&q=80`

Pipeline:
1. Parse URL → resolve the path inside `PROJECTS_PATH`; anything outside it gets a 403 [fork]
2. Check SHA256-keyed disk cache (`PROJECTS_PATH/.cache`)
3. If raw file requested → `net.fetch(pathToFileURL(...))`
4. Otherwise → Sharp: resize / convert format / adjust quality
5. Cache result, return `Response` with correct `Content-Type`

Query params (long names also accepted): `w` width, `h` height, `m` mode (cover/contain), `q` quality, `f` format (jpg/jpeg/webp/avif), `c` cache flag, `i=json` info-only (returns JSON metadata).

When you add a new image variant or resize option, add the param to the resizer in `src/common/resizer.js` **and** to `routes.js`.

---

## Web — Service Worker as fake backend

On the web there is no server. A Service Worker intercepts requests to `/api/pictures/*` and serves images directly from IndexedDB.

**Registration — `src/renderer/index.jsx`:** on `load`, when `window.IPC` is undefined, `navigator.serviceWorker.register('./sw.js', { type: 'module' })`.

**Service Worker — `src/backend-web/sw-web.js` (compiled to `/sw.js`):**

```
fetch /api/pictures/{frameId}?w=...&f=...
  → parse frameId and query params
  → getFrameBlob(frameId)   ← reads from IndexedDB
  → loadImageToCanvas()     ← decode Blob → OffscreenCanvas
  → ExportFrame()           ← resize + format-convert via OffscreenCanvas
  → return Blob as Response
```

The Service Worker is bundled by a **custom Vite plugin** (`serviceWorkerPlugin` in `vite.config.mjs`) that inlines all its dependencies (including the IndexedDB helpers). If you add a new dependency inside `sw-web.js`, make sure the plugin can resolve it.

This means the web app works offline after first load — no backend required.

---

## Adding a new action

1. Add handler to `src/backend-electron/actions.js` (Electron path). Validate every id, file name and extension from the renderer with the helpers in `core/paths.js` (see Security below).
2. Add the same handler to `src/backend-web/actions/index.js` (web path).
3. Android has its own native backend (`ActionDispatcher.kt`). Either implement the action there too, or gate the feature behind a capability Android does not list (this is what audio dubbing does).
4. Call it anywhere via `await window.EA('MY_ACTION', data)`.

Both JS handlers receive `(event, data)` — `event` is the Electron IPC event on desktop, `null` on web.

---

## Build scripts

| Command | What it does |
|---|---|
| `npm run start:electron` | Electron dev with HMR |
| `npm run start:web` | Web dev server |
| `npm run build:web` | Production web build → `out/web/` |
| `npm run start:web:prod` | Serve `out/web/` on http://localhost:4173 |
| `npm run build:win/mac/linux` | Packaged Electron release → `binaries/` |
| `npm run build:unpack` | Unpacked Electron app → `binaries/*-unpacked/` |
| `npm run lint` | ESLint + Stylelint + Prettier, all auto-fixing |
| `npm run extract-strings` | Collect new `t('…')` keys into `resources/i18n/` |

To package locally without any publish attempt: `npx electron-vite build && npx electron-builder --linux --dir -p never` (on `master`-based branches the `build:*` scripts lack `-p never`). Never commit `binaries/` or `out/`.

---

## Storage layout

**Electron (filesystem):** `PROJECTS_PATH` is `~/EagleAnimation/` if that older folder exists, otherwise the env-paths data folder: `~/.local/share/EagleAnimation` (Linux), `%LOCALAPPDATA%\EagleAnimation\Data` (Windows), `~/Library/Application Support/EagleAnimation` (macOS).
```
PROJECTS_PATH/
├── settings.json
├── .cache/                      # ea:// resize cache
└── {project_id}/
    ├── project.eagleanimation   # JSON project metadata
    └── {scene_index}/
        ├── {frame_filename}     # JPEG/PNG frame images
        └── {uuid}.wav           # [fork] audio dubbing takes
```

**Web (IndexedDB via Dexie):**
- `ProjectDatabase.projects` — serialised project JSON
- `BlobFramesDatabase` — frame blobs keyed by frame ID; audio takes are stored the same way [fork]
- Settings live in `localStorage`

---

## Audio dubbing [fork]

**Opening it:** the microphone button in the Animator control bar, or the `d` shortcut (`AUDIO_DUBBING` in `core/shortcuts.js`). It opens `DubbingWindow` full screen, like the masking editor, and is only offered when the backend lists the `AUDIO_DUBBING` capability (Electron and web; Android does not implement the audio actions yet).

**Controls** (`core/dubInput.js`) mirror capture mode:

| Action | Keyboard | Gamepad |
|---|---|---|
| Record (hold) | Enter, R | A, right bumper |
| Play / stop | Space, P | X, Start |
| Undo | Z | Y |
| Step back / forward | ← → (or `,` `.`); held >300 ms repeats at the scene framerate | D-pad; triggers scrub analog, 0–24 fps |
| First / last frame | Home / End | |
| Close | Escape | |

A microphone dropdown in the header saves its choice to the `AUDIO_INPUT_ID` setting.

**How a take works:**
1. While record is held, the mic is captured by an AudioWorklet loaded from a `blob:` URL (the Electron CSP allows `blob:` for this). Each step taken while recording marks a frame boundary, timestamped against the audio clock. The mic's reported input latency is subtracted, and a one-second pre-roll lets that correction reach just before the press.
2. On release, the take is encoded as mono 16-bit WAV (`wav.js`) and saved with `SAVE_AUDIO`.
3. `computeTakeChanges` (`dubbing.js`) snaps the boundaries to scene ticks. `useProject().applyDub` then writes the new lengths and audio slices as **one undo step**. Recording over frames that already have audio replaces it.

**Data model:** `picture.length` is the frame's duration in ticks at `scene.framerate` (1 to `MAX_FRAME_DUPLICATION`). `picture.audio = { filename, offset, duration }` points to a slice of a take, with offset and duration in seconds. Deleted and hidden frames are skipped.

**Export:** `views/Export.jsx` calls `renderExportAudio` (`dubAudio.js`), which mixes the slices against the frames actually exported, so holds and duplicated frames stay in sync. The result goes into an export buffer, and `EXPORT` receives it as `audio_buffer_id`. On Electron, `export.js` copies it in as `audio.wav` and `common/ffmpeg.js` adds the audio stream for each profile (AAC, Opus or PCM). On the web, ffmpeg.wasm or WebCodecs encode it; `isWebCodecsAudioAvailable` checks the codec first. Frame-only exports ignore audio.

The dubbing view deliberately sends **no analytics events**.

---

## Security and privacy hardening [fork]

These are deliberate decisions by the owner. Keep them when changing nearby code:

- **Path validation.** Everything the renderer sends that becomes a path goes through `src/backend-electron/core/paths.js`: `getProjectPath`, `assertSafeName`, `assertExtension`, `assertTrackId`, `assertFrameIndex` and `isInsideFolder`. Never write `join(PROJECTS_PATH, project_id)` directly.
- **Exports.** `EXPORT` writes only to the path the user just picked through `EXPORT_SELECT_PATH` (`selectedExportPath` in `actions.js`). `mode: 'send'` is the only exception.
- **Audio files.** `SAVE_AUDIO` always writes `.wav`, and the renderer cannot choose the extension. `GET_AUDIO` only reads safe `.wav` names.
- **Links.** Open external links only with `openWebLink` (`core/utils.js`, http/https only), never with `shell.openExternal`. `window.open` is denied and sent to the browser, and `will-navigate` is blocked.
- **No remote or eval'd code, ever.**
  - The Electron renderer build injects a CSP meta tag (`contentSecurityPolicy()` in `electron.vite.config.mjs`): `script-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'`.
  - Separately, the main process cancels any network `script`, `subFrame` or `object` request (`onBeforeRequest` in `index.js`; only the dev server is allowed).
  - Don't loosen either one. Adding WASM to the Electron renderer, for example, would need `'wasm-unsafe-eval'`, so check with the owner first.
- **Telemetry is opt-in and off by default.**
  - The setting key is `TELEMETRY_OPT_IN`. The old upstream key `TELEMETRY_ENABLED` is ignored on purpose, so existing installs stay off.
  - PostHog is not even initialised until the user opts in.
  - When it is, it runs with `disable_external_dependency_loading`, `advanced_disable_flags`, and no surveys, session recording or autocapture. Opted in, it sends only to the `/e/` events endpoint.
- **Discord is off by default.** `DISCORD_ENABLED` defaults to false, and the switch is Electron only (`DISCORD` capability). `core/discord.js` connects lazily, only while the setting is on. Turning it off clears the status and closes the socket.
- **Web and Android builds don't get the CSP**; they rely on PostHog never starting unless the user opts in.

---

## Verifying changes

- **Lint:** `npm run lint`. Upstream ships a few files that are not lint-clean (`CameraCapabilityItem/style.module.css`, `CameraSettingsWindow/index.jsx`, `FormGroup/style.module.css`, `LimitWarning/style.module.css`, and on `develop` also `styles/global.css`). Revert lint's changes to those files with `git checkout --` so commits only carry your own changes.
- **Translations:** use the `translate` skill. Every one of the 22 languages must report 0 untranslated.
- **Web:** use the `verify` skill. In a cloud container, use the preinstalled Playwright (`require('playwright').chromium.launch()`) instead of `msedge`.
- **Electron (packaged)** — the owner's real target:
  1. `npm ci`. If `node_modules/ffmpeg-static/ffmpeg` is missing, run `node node_modules/ffmpeg-static/install.js`.
  2. Package without publishing (see Build scripts).
  3. Drive `binaries/linux-unpacked/eagle-animation` with Playwright's `_electron.launch({ executablePath, args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })` under `xvfb-run -a`.
  4. Preset state by writing `~/.local/share/EagleAnimation/settings.json` before launch. Use `TOUCAN_CAMERA_SERVER_DISABLED: true` so the fake webcam is used, and `TOURS_COMPLETED: ['HOME', 'ANIMATOR', 'SETTINGS']`.
  5. Stub native dialogs with `app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) })`.
  6. Delete `binaries/` and the data folder afterwards.
- **What to re-check after touching the areas above:**
  - Capture → dub → export produces an MP4 with an AAC track as long as the video.
  - Path tricks through `SAVE_PICTURE`, `EXPORT_BUFFER`, `SAVE_AUDIO`, `GET_AUDIO`, `GET_PROJECT` and `EXPORT` are refused, and `ea://` traversal fails.
  - Only http(s) links open, and the window can't navigate.
  - Remote scripts and `eval` are blocked.
  - A fresh install makes no network requests and no Discord connection.
  - Opting in to telemetry sends only events.
  - Turning Discord off in Settings closes the socket.
- **Testing gotchas:**
  - PostHog drops every event when `navigator.webdriver` is true, which it always is under Playwright. To see what a real user sends, run `addInitScript(() => Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false }))` and then `page.reload()`.
  - `page.evaluate` is exempt from the page's CSP, so test `eval` or remote scripts from a `blob:` script the page itself loads.
  - To fake Discord, have a `net` server listen on `$XDG_RUNTIME_DIR/discord-ipc-0` and pass that `XDG_RUNTIME_DIR` to the app. Call `socket.resume()`, or `'close'` never fires when the app disconnects.
  - `Switch` hides its checkbox, so click the surrounding `<label>`.
  - Stop a background `vite preview` by PID. `pkill -f` with the command text also kills the shell running it.
- **Not buildable in the cloud container:** Android (Gradle can't reach `dl.google.com`). Windows is tested by the owner.

---

## Key conventions

- **No global state library.** State lives in custom hooks (`useProject`, `useProjects`, `useSettings`). Each hook calls `EA()` and/or subscribes with `EAEvents()`.
- **Image URLs are platform-specific.** Electron returns `ea://…` URLs; web returns `/api/pictures/…` URLs. Never hardcode either format — always use the URL returned by the backend.
- **FFmpeg args are shared.** Codec selection and bitrate logic lives in `src/common/ffmpeg.js`. Platform-specific execution is in `src/backend-electron/core/export.js` (native) and `src/backend-web/actions/ffmpeg.js` / `webcodecs.js` (web).
- **Translations.** Keys are the English strings, extracted by `i18next-scanner`. Run `npm run extract-strings` after adding new `t('key')` calls, then fill every language (see the `translate` skill).
- **Comments stay short.** One or two lines, `//` only — never `/* */` or JSDoc blocks. Explain why, not what; if it needs a paragraph, the code needs the rework instead.
