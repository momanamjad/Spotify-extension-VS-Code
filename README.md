# Spotify Mini Player

> A premium VS Code sidebar and mini-player for Spotify — with keyboard shortcuts, voice control, album art, and full OAuth login.

---

## Features

- 🎵 **Now Playing** — track title, artist, album art, and live progress bar in the sidebar
- 🎮 **Playback Controls** — Play/Pause, Next, Previous via SVG icon buttons or keyboard shortcuts
- 🔊 **Volume Control** — Volume slider and +/− buttons
- 🎤 **Voice Control** — Trigger playback actions by voice from within VS Code
- 📡 **Live State Sync** — Playback state refreshes on a timer and when VS Code regains focus
- 🪟 **Mini Player** — Detachable mini-player panel alongside your code
- 📊 **Status Bar** — Track name and artist always visible in the bottom bar
- 🔐 **OAuth PKCE Login** — Secure login with no client secret required

---

## Account Modes

### Premium

Uses the **Spotify Web API** directly for:

- Play / Pause (responds in ~200–400ms)
- Next / Previous track
- Volume control (Spotify app volume)
- Reading current device, track info, and progress

### Free

Automatically switches to **desktop mode**:

- Play / Pause, Next, Previous use **Windows media keys** (via the OS media session API)
- Volume controls the **Spotify app audio session** on Windows
- A clear banner explains the mode; no silent failures
- Non-Windows platforms open Spotify in the browser as fallback

---

## Requirements

- VS Code `1.85.0` or newer
- A [Spotify Developer App](https://developer.spotify.com/dashboard) with a **Client ID**
- The redirect URI `http://127.0.0.1:17523/callback` registered in your Spotify app
- **Spotify Premium** for direct Web API playback control (Free accounts work in desktop mode)

---

## Setup

1. Create an app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
2. Copy the **Client ID**.
3. In VS Code open **Settings** → search for `spotifyPlayer.clientId` → paste the Client ID.
4. In the Spotify Dashboard, add this **Redirect URI** exactly:
   ```
   http://127.0.0.1:17523/callback
   ```
5. Open the Spotify sidebar in VS Code and click **Connect to Spotify**.
6. Complete the browser sign-in flow.

You can also set the Client ID via an environment variable:

```
SPOTIFY_CLIENT_ID=your_client_id
```

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `spotifyPlayer.clientId` | `""` | Spotify app Client ID |
| `spotifyPlayer.redirectUri` | `http://127.0.0.1:17523/callback` | OAuth redirect URI |
| `spotifyPlayer.refreshIntervalSeconds` | `15` | State refresh interval (min 5s) |
| `spotifyPlayer.preferredDevices` | `[]` | Device names to prefer for playback |

---

## Commands

| Command | Description |
|---|---|
| `Spotify Player: Connect to Spotify` | Start OAuth login |
| `Spotify Player: Disconnect` | Clear session and sign out |
| `Spotify Player: Refresh Status` | Manually refresh playback state |
| `Spotify Player: Show Sidebar` | Open the Spotify sidebar |
| `Spotify Player: Show Mini Player` | Open the detachable mini player |
| `Spotify Player: Play / Pause` | Toggle playback |
| `Spotify Player: Next Track` | Skip to next |
| `Spotify Player: Previous Track` | Go to previous |
| `Spotify Player: Volume Up` | Increase volume by 10% |
| `Spotify Player: Volume Down` | Decrease volume by 10% |
| `Spotify Player: Toggle Voice Control` | Enable/disable voice commands |

---

## Keyboard Shortcuts

| Shortcut (Windows/Linux) | Shortcut (Mac) | Action |
|---|---|---|
| `Ctrl+Alt+P` | `Cmd+Alt+P` | Play / Pause |
| `Ctrl+Alt+Right` | `Cmd+Alt+Right` | Next Track |
| `Ctrl+Alt+Left` | `Cmd+Alt+Left` | Previous Track |

---

## Performance

- **Premium mode:** button response ~200–400ms (Spotify API latency)
- **Free mode (Windows):** first click ~1.5s (PowerShell boot), subsequent clicks ~50–200ms via persistent shell session
- State refresh in Premium mode with active playback: **2 API calls** (down from 4)

---

## Security

- OAuth uses **PKCE** — no client secret is required or stored
- The refresh token is stored in **VS Code's encrypted secret storage** (`context.secrets`)
- Webviews enforce a **Content Security Policy (CSP)** with nonce-locked scripts
- OAuth state mismatch (CSRF) **aborts authentication** and surfaces an error
- Login response messages are **HTML-escaped** to prevent injection

---

## Known Limitations

- Spotify's playback API endpoints (play, pause, next, volume) require **Spotify Premium**
- Free accounts use OS media keys — this requires Spotify Desktop to be open and playing
- On non-Windows platforms, Free mode opens Spotify in the browser instead
- Album art search uses the iTunes API as a fallback when Spotify returns no artwork

---

## Troubleshooting

### "Spotify login could not be completed"

- Confirm the redirect URI is exactly `http://127.0.0.1:17523/callback`
- Confirm the same URI is registered in the Spotify developer dashboard
- Do not reload VS Code or the Extension Host while the browser login is open

### "Connect to Spotify first"

You are not signed in. Click **Connect to Spotify** in the sidebar.

### Buttons do nothing (Free account)

Make sure **Spotify Desktop** is open and a song is playing or paused. The OS media session must be active.

### No album art

The track art may not be available immediately. Click **Refresh** or wait for the next poll cycle.

### `source=none` in diagnostics

1. Disconnect and reconnect (clears and re-grants scopes).
2. Start a song in Spotify.
3. Click **Refresh**.
4. Check that diagnostics shows `current-playback` or `currently-playing`.

---

## Folder Layout

```
.
├── .vscode/
│   └── launch.json
├── media/
│   ├── icon.svg
│   ├── icon128.png        ← 128×128 Marketplace icon
│   ├── webview.css        ← Glassmorphism design system + responsive layout
│   ├── webview.html       ← SVG icon controls, CSP, Google Fonts
│   └── webview.js         ← Frontend state sync and button wiring
├── extension.js           ← Activation, OAuth, playback logic, persistent PS shell
├── package.json
├── LICENSE
└── README.md
```

---

## Development

### Run Locally

1. Open this folder in VS Code.
2. Press `F5` to launch the Extension Development Host.
3. Use the Spotify sidebar in the new window.

### Package for Distribution

```bash
npm install
npm run package   # produces spotify-mini-player-x.x.x.vsix
```

### Publish to Marketplace

1. Create a publisher account at [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage).
2. Generate a Personal Access Token with **Marketplace publish** scope.
3. Run:
   ```bash
   npx vsce login momanamjad
   npm run publish
   ```

> **Before publishing:** replace `media/icon128.png` with your actual 128×128 PNG icon.

---

## Changelog

### v0.2.0

- **Performance:** Persistent PowerShell session — Free mode buttons now respond in ~50–200ms (down from 2–4s)
- **Performance:** Premium play/pause no longer pre-fetches playback state (saves ~250ms per click)
- **Performance:** Next/Previous no longer pre-fetches device list (saves ~250ms per click)
- **Performance:** State refresh uses 2 API calls when playback is active (down from 4)
- **Performance:** HTML template cached after first read — no blocking I/O on each webview render
- **Performance:** Removed `transition: all` from global CSS selector — progress bar now animates at 180ms linear
- **Security:** OAuth state mismatch now aborts authentication (closes CSRF bypass)
- **Security:** Login response messages are HTML-escaped
- **UI:** Glassmorphism design system with Inter font, deep-space color palette, and neon accents
- **UI:** SVG icon controls (play, pause, next, previous, volume, voice)
- **UI:** Fully responsive down to sub-300px sidebar widths
- **Packaging:** `.vscodeignore`, `LICENSE`, `publisher`, `repository`, `galleryBanner` added

### v0.1.0

- Initial release: OAuth PKCE login, Premium + Free mode split, sidebar and mini player, voice control, status bar, Windows media key fallback

---

## License

MIT © 2026 Moman Amjad
