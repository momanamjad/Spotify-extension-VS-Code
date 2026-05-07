# Spotify Mini Player

Spotify Mini Player is a VS Code extension with a Spotify-themed sidebar, a mini player panel, keyboard shortcuts, voice control, and Spotify OAuth login.

The extension now has a real account-tier split:

- `Premium` accounts use the Spotify Web API for direct playback control.
- `Free` accounts switch to desktop mode and control the installed Spotify app through OS media keys.

## Current Condition

This project is functional and interactive, but it is still an in-development extension rather than a polished Marketplace release.

What currently works:

- OAuth sign-in with Spotify
- Saving and restoring the refresh token in VS Code secret storage
- Detecting `free` vs `premium` from the Spotify profile
- Showing a banner for account tier and playback availability
- Disconnecting and clearing the saved Spotify session
- Refreshing playback state from Spotify
- Sidebar and mini-player webviews
- Status bar updates
- Voice control UI
- An in-sidebar diagnostics card that shows the latest response source and summary
- Premium playback control through the Spotify Web API
- Free-account desktop playback actions through Windows media keys or browser/manual fallback

What is intentionally limited:

- Spotify Web API playback endpoints are only used for Premium accounts
- Free accounts do not call the Premium-only playback API endpoints
- Free accounts use best-effort fallback behavior:
  - on Windows, the extension sends OS media keys
  - on other platforms, it opens Spotify and shows guidance
- Next, Previous, and Volume follow the same fallback strategy instead of failing silently

## Behavior By Account Type

### Premium

Premium accounts use the Spotify Web API for:

- Play / Pause
- Next track
- Previous track
- Volume changes
- Reading current playback state
- Reading the active device
- Showing current track info, artist, and album art

The sidebar and status bar stay in sync with the active Spotify device.

### Free

Free accounts automatically switch to desktop mode:

- A banner explains that controls use the installed Spotify app through OS media keys
- Play / Pause uses the same media-control path as keyboard media buttons
- Next, Previous, and Volume use OS media keys where available
- If media keys are unavailable, the extension opens Spotify and shows a clear message instead of failing silently
- The UI still shows account status, connection state, diagnostics, and last action
- Disconnect still works

## Requirements

- VS Code `1.85.0` or newer
- A Spotify developer app with a Client ID
- A redirect URI registered in the Spotify dashboard
- Spotify Premium for direct Web API playback control

## Setup

1. Create an app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
2. Copy the app's Client ID.
3. In VS Code, set `spotifyPlayer.clientId` to that Client ID.
4. Make sure the redirect URI matches exactly:
   - `http://127.0.0.1:17523/callback`
5. Add the same redirect URI in your Spotify app settings.
6. Press `F5` to launch the Extension Development Host.
7. Run `Spotify Player: Connect to Spotify`.
8. Finish the browser sign-in flow.

You can also set the Client ID with the environment variable:

- `SPOTIFY_CLIENT_ID`

## Settings

The extension contributes these settings:

- `spotifyPlayer.clientId`
  - Spotify app Client ID for OAuth login
- `spotifyPlayer.redirectUri`
  - Redirect URI used during OAuth
- `spotifyPlayer.refreshIntervalSeconds`
  - How often playback state refreshes
- `spotifyPlayer.preferredDevices`
  - Optional list of device names to prefer

## Commands

- `Spotify Player: Connect to Spotify`
- `Spotify Player: Disconnect`
- `Spotify Player: Refresh Status`
- `Spotify Player: Show Sidebar`
- `Spotify Player: Show Mini Player`
- `Spotify Player: Play / Pause`
- `Spotify Player: Next Track`
- `Spotify Player: Previous Track`
- `Spotify Player: Volume Up`
- `Spotify Player: Volume Down`
- `Spotify Player: Toggle Voice Control`

## Keyboard Shortcuts

- `Ctrl + Alt + P`
- `Ctrl + Alt + Right`
- `Ctrl + Alt + Left`

## Current UI

The sidebar includes:

- connection status
- account tier banner
- active device details
- now playing info
- playback controls
- volume slider
- voice control entry point
- last action and error text
- diagnostics for the latest Spotify payload
- account-tier messaging that switches between Premium and basic mode

The mini player uses the same controller state and mirrors the main playback data.

The current source layout is:

- `extension.js` for activation, OAuth, state, and playback logic
- `media/webview.html` for the sidebar and mini-player markup
- `media/webview.css` for the visuals
- `media/webview.js` for the frontend state and button wiring

## Disconnect Behavior

Disconnect now:

- clears the saved refresh token from secret storage
- clears the in-memory access token
- resets the user/session state
- returns the UI to a signed-out state
- updates the status bar and sidebar

If disconnect appears stale, restart the Extension Development Host and try again.

## Known Limitations

- Spotify's official playback endpoints are Premium-only.
- Free accounts cannot be controlled through the Spotify Web API in the same way as Premium accounts.
- The basic fallback depends on the platform and the Spotify client.
- If there is no active Spotify device, playback details may be incomplete until Spotify is opened on a device.
- On Windows, the basic fallback uses a temporary PowerShell script to send media keys.

## Troubleshooting

### "Spotify login could not be completed"

Check:

- the redirect URI is exactly `http://127.0.0.1:17523/callback`
- the same redirect URI is registered in the Spotify dashboard
- you only clicked Connect once during sign-in
- the Extension Development Host was not reloaded mid-login

### "Connect to Spotify first"

You are not signed in yet, or the saved session was cleared.

### "Premium required for playback controls"

You are signed in with a Free account. The extension is intentionally switching to basic mode.

### No active device

Open Spotify on one of these first:

- Spotify desktop app
- Spotify web player
- Spotify mobile app

Then refresh the extension.

### Diagnostics show `source=none`

The extension could not get a live payload from Spotify yet. Try:

1. Disconnect and reconnect so the updated scopes are granted.
2. Start playback in the same Spotify account you connected with.
3. Click `Refresh`.
4. Check whether the diagnostics card changes to `current-playback`, `currently-playing`, or `recently-played`.

## Folder Layout

```text
.
├── .vscode
│   └── launch.json
├── media
│   ├── icon.svg
│   ├── webview.css
│   ├── webview.html
│   └── webview.js
├── extension.js
├── package.json
└── README.md
```

## Development Notes

- The extension entrypoint is `extension.js`
- Webview UI code is split across `media/webview.html`, `media/webview.css`, and `media/webview.js`
- The Spotify login flow uses PKCE
- The refresh token is stored in VS Code secret storage
- Playback state is refreshed on a timer and when the VS Code window regains focus

## Run Locally

1. Open this folder in VS Code.
2. Press `F5`.
3. Use the Spotify sidebar in the Extension Development Host window.

## Packaging

This repository does not yet include a release pipeline. If you want to package it later, you can use `vsce` after updating publisher metadata in `package.json`.
