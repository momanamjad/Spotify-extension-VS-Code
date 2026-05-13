const vscode = require("vscode");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const os = require("os");
const { execFile, spawn } = require("child_process");

const SPOTIFY_API = "https://api.spotify.com/v1";
const SPOTIFY_AUTH = "https://accounts.spotify.com";
const DEFAULT_REDIRECT_URI = "http://127.0.0.1:17523/callback";
const REFRESH_TOKEN_KEY = "spotifyPlayer.refreshToken";
const DEFAULT_SCOPES = [
  "user-read-private",
  "user-read-currently-playing",
  "user-read-recently-played",
  "user-read-playback-state",
  "user-modify-playback-state",
];

function readTemplate(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

// Cache template to avoid blocking I/O on every webview render
let _templateCache = null;
function readTemplateCached(filePath) {
  // Disable caching for development to ensure changes are picked up
  return fs.readFileSync(filePath, "utf8");
}

// Escape HTML to prevent injection in loginResponse messages
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Manages a single long-running PowerShell process.
 * Scripts are sent over stdin; each result is delimited by a unique end-marker.
 * This eliminates the ~1.5s cold-start overhead of spawning a new process per command.
 */
class PersistentPowerShell {
  constructor() {
    this._proc = null;
    this._queue = []; // { script, resolve, reject, timer }
    this._current = null;
    this._buf = "";
    this._starting = null;
  }

  /** Ensure the PS process is running; returns a promise that resolves when ready. */
  _ensureStarted() {
    if (this._proc && !this._proc.killed) {
      return Promise.resolve();
    }
    if (this._starting) {
      return this._starting;
    }
    this._starting = new Promise((resolve, reject) => {
      const proc = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "-",
        ],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
      proc.on("error", (err) => {
        this._proc = null;
        this._starting = null;
        reject(err);
        this._failCurrent(err);
      });
      proc.on("exit", () => {
        this._proc = null;
        this._starting = null;
        // Fail any in-flight command so callers don't hang
        this._failCurrent(new Error("PowerShell process exited unexpectedly."));
        // Drain remaining queue items — they'll restart the process
        this._drainQueue();
      });
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk) => this._onData(chunk));
      proc.stderr.setEncoding("utf8");
      // stderr is silently collected; errors surface through the end-marker protocol
      proc.stderr.on("data", () => {});
      this._proc = proc;
      this._starting = null;
      resolve();
    });
    return this._starting;
  }

  _onData(chunk) {
    this._buf += chunk;
    if (!this._current) return;
    const marker = this._current.marker;
    const idx = this._buf.indexOf(marker);
    if (idx === -1) return;
    // Everything before the marker is the output
    const output = this._buf.slice(0, idx).trim();
    this._buf = this._buf.slice(idx + marker.length);
    const { resolve, timer } = this._current;
    this._current = null;
    clearTimeout(timer);
    resolve(output);
    this._drainQueue();
  }

  _failCurrent(err) {
    if (!this._current) return;
    const { reject, timer } = this._current;
    this._current = null;
    clearTimeout(timer);
    reject(err);
  }

  _drainQueue() {
    if (this._current || this._queue.length === 0) return;
    const item = this._queue.shift();
    this._current = item;
    const wrapped = `${item.script}\nWrite-Host '${item.marker}'\n`;
    try {
      this._proc.stdin.write(wrapped);
    } catch (err) {
      this._failCurrent(err);
    }
  }

  /**
   * Run a PowerShell script string and return its stdout as a string.
   * @param {string} script  - PS commands to execute
   * @param {number} timeout - milliseconds before the call is rejected
   */
  run(script, timeout = 10000) {
    return this._ensureStarted().then(
      () =>
        new Promise((resolve, reject) => {
          const marker = `__PS_DONE_${crypto.randomBytes(8).toString("hex")}__`;
          const timer = setTimeout(() => {
            // Kill and reset on timeout so the next call gets a fresh process
            try {
              this._proc?.kill();
            } catch {}
            this._proc = null;
            this._current = null;
            reject(new Error(`PowerShell script timed out after ${timeout}ms`));
          }, timeout);
          const item = { script, resolve, reject, marker, timer };
          this._queue.push(item);
          this._drainQueue();
        }),
    );
  }

  dispose() {
    try {
      this._proc?.stdin?.end();
    } catch {}
    try {
      this._proc?.kill();
    } catch {}
    this._proc = null;
  }
}

// Singleton — one persistent shell for the entire extension lifetime
const psShell = new PersistentPowerShell();

function randomString(length = 64) {
  return crypto.randomBytes(length).toString("base64url").slice(0, length);
}

function challenge(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function buildUrl(baseUrl, params) {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function normalizeList(value) {
  if (Array.isArray(value)) {
    return value.filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function getTrackText(track) {
  const artists = Array.isArray(track?.artists)
    ? track.artists.map((artist) => artist.name).filter(Boolean)
    : [];
  return {
    title: track?.name || "No song playing",
    artist: artists.length ? artists.join(", ") : "Spotify",
    albumArt:
      Array.isArray(track?.album?.images) && track.album.images[0]
        ? track.album.images[0].url
        : "",
  };
}

function isWindows() {
  return process.platform === "win32";
}

function formatDuration(ms) {
  const safeMs = Math.max(0, Number(ms) || 0);
  const totalSeconds = Math.floor(safeMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function isRenderableAlbumArt(value) {
  return (
    typeof value === "string" &&
    /^(https?:\/\/|data:image\/)/i.test(value.trim())
  );
}

function trackAlbumArt(track) {
  const image = Array.isArray(track?.album?.images)
    ? track.album.images.find((entry) => isRenderableAlbumArt(entry?.url))
    : null;
  return image?.url || "";
}

function pickPreferredAlbumArt(...candidates) {
  for (const candidate of candidates) {
    if (
      typeof candidate === "string" &&
      /^https?:\/\//i.test(candidate.trim())
    ) {
      return candidate.trim();
    }
  }

  for (const candidate of candidates) {
    if (isRenderableAlbumArt(candidate)) {
      return candidate.trim();
    }
  }

  return "";
}

class SpotifyPlayerState {
  constructor() {
    this.playing = false;
    this.title = "No song playing";
    this.artist = "Spotify";
    this.albumArt = "";
    this.progressMs = 0;
    this.durationMs = 0;
    this.progressLabel = "0:00";
    this.durationLabel = "0:00";
    this.volume = 70;
    this.authenticated = false;
    this.authStatus = "Not connected";
    this.userName = "";
    this.product = "";
    this.deviceName = "No active device";
    this.deviceType = "";
    this.deviceVolume = 70;
    this.voiceActive = false;
    this.authInProgress = false;
    this.canControlPlayback = false;
    this.basicControlsAvailable = isWindows();
    this.accountMode = "signed-out";
    this.tierMessage = "";
    this.debugSource = "none";
    this.debugSummary = "No Spotify response yet.";
    this.mode = "sidebar";
    this.lastAction = "Ready";
    this.error = "";
    this.authStartTime = 0;
  }
}

class SpotifyPlayerController {
  constructor(context) {
    this.context = context;
    this.state = new SpotifyPlayerState();
    this.webviews = new Set();
    this.panel = undefined;
    this.sidebarView = undefined;
    this.templatePath = context.asAbsolutePath(
      path.join("media", "webview.html"),
    );
    this.stylePath = context.asAbsolutePath(path.join("media", "webview.css"));
    this.scriptPath = context.asAbsolutePath(path.join("media", "webview.js"));
    this.statusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    this.statusBar.command = "spotifyPlayer.showSidebar";
    this.statusBar.tooltip = "Spotify Mini Player";
    this.statusBar.show();
    this.session = {
      accessToken: "",
      refreshToken: "",
      expiresAt: 0,
      user: null,
    };
    this.pendingAuth = null;
    this.server = null;
    this.pollTimer = null;
    this.refreshing = null;
    this.refreshDebounce = null;

    this.registerCommands();
    // Bootstrap lazily to avoid extension host startup timeout
    setTimeout(() => void this.bootstrap(), 100);
  }

  settings() {
    const config = vscode.workspace.getConfiguration("spotifyPlayer");
    return {
      clientId: process.env.SPOTIFY_CLIENT_ID || config.get("clientId", ""),
      redirectUri: config.get("redirectUri", DEFAULT_REDIRECT_URI),
      refreshIntervalSeconds: config.get("refreshIntervalSeconds", 3),
      preferredDevices: normalizeList(config.get("preferredDevices", [])),
    };
  }

  registerCommands() {
    const sidebarProvider = {
      resolveWebviewView: async (webviewView) => {
        try {
          this.sidebarView = webviewView;
          this.configureWebview(webviewView.webview, "sidebar");
          webviewView.onDidDispose(() => {
            this.webviews.delete(webviewView.webview);
            if (this.sidebarView === webviewView) {
              this.sidebarView = undefined;
            }
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          vscode.window.showErrorMessage(
            `Spotify sidebar failed to load: ${message}`,
          );
          throw error;
        }
      },
    };

    this.context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        "spotifyPlayer.sidebarView",
        sidebarProvider,
        {
          webviewOptions: { retainContextWhenHidden: true },
        },
      ),
      vscode.commands.registerCommand("spotifyPlayer.showSidebar", () => {
        void vscode.commands.executeCommand(
          "workbench.view.extension.spotifyPlayerSidebar",
        );
      }),
      vscode.commands.registerCommand("spotifyPlayer.showMiniPlayer", () =>
        this.openMiniPlayer(),
      ),
      vscode.commands.registerCommand(
        "spotifyPlayer.connect",
        () => void this.startLogin(),
      ),
      vscode.commands.registerCommand(
        "spotifyPlayer.logout",
        () => void this.logout(),
      ),
      vscode.commands.registerCommand(
        "spotifyPlayer.refreshStatus",
        () => void this.refreshPlaybackState(),
      ),
      vscode.commands.registerCommand(
        "spotifyPlayer.togglePlayPause",
        () => void this.dispatchAction("play-pause"),
      ),
      vscode.commands.registerCommand(
        "spotifyPlayer.nextTrack",
        () => void this.dispatchAction("next-track"),
      ),
      vscode.commands.registerCommand(
        "spotifyPlayer.previousTrack",
        () => void this.dispatchAction("previous-track"),
      ),
      vscode.commands.registerCommand(
        "spotifyPlayer.volumeUp",
        () => void this.dispatchAction("volume-up"),
      ),
      vscode.commands.registerCommand(
        "spotifyPlayer.volumeDown",
        () => void this.dispatchAction("volume-down"),
      ),
      vscode.commands.registerCommand(
        "spotifyPlayer.toggleVoiceControl",
        () => void this.dispatchAction("toggle-voice"),
      ),
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) {
          void this.refreshPlaybackState({ silent: true });
        }
      }),
    );
  }

  async bootstrap() {
    try {
      const refreshToken = await this.context.secrets.get(REFRESH_TOKEN_KEY);
      this.session.refreshToken = refreshToken || "";
      if (this.session.refreshToken) {
        this.state.lastAction = "Restored saved Spotify session";
        try {
          await this.refreshAccessToken(true);
          await this.refreshPlaybackState({ silent: true });
        } catch {
          this.updateAuthState(false, "Spotify session needs reconnecting");
        }
      } else {
        this.updateAuthState(false, "Not connected");
        await this.refreshBasicPlaybackState({ silent: true });
      }

      this.startPolling();
      this.pushState();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state.lastAction = message;
      this.state.error = message;
      this.pushState();
    }
  }

  startPolling() {
    const intervalMs =
      Math.max(2, this.settings().refreshIntervalSeconds) * 1000;
    this.pollTimer = setInterval(
      () => void this.refreshPlaybackState({ silent: true }),
      intervalMs,
    );
    this.context.subscriptions.push({
      dispose: () => clearInterval(this.pollTimer),
    });
  }

  scheduleRefresh(delay = 180) {
    if (this.refreshDebounce) {
      clearTimeout(this.refreshDebounce);
    }
    this.refreshDebounce = setTimeout(() => {
      this.refreshDebounce = null;
      void this.refreshPlaybackState({ silent: true });
    }, delay);
  }

  async saveRefreshToken(refreshToken) {
    this.session.refreshToken = refreshToken;
    if (refreshToken) {
      await this.context.secrets.store(REFRESH_TOKEN_KEY, refreshToken);
    } else {
      await this.context.secrets.delete(REFRESH_TOKEN_KEY);
    }
  }

  runWindowsPowerShell(script, label = "spotify-helper", timeout = 8000) {
    if (!isWindows()) {
      return Promise.resolve(false);
    }

    return new Promise((resolve, reject) => {
      const tempScriptPath = path.join(
        os.tmpdir(),
        `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}.ps1`,
      );

      fs.writeFile(tempScriptPath, script, "utf8", (writeError) => {
        if (writeError) {
          reject(writeError);
          return;
        }

        execFile(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            tempScriptPath,
          ],
          { windowsHide: true, timeout },
          (error, stdout, stderr) => {
            fs.unlink(tempScriptPath, () => {});
            if (error) {
              reject(new Error(stderr || error.message));
              return;
            }
            resolve(stdout.trim());
          },
        );
      });
    });
  }

  async sendWindowsMediaKey(vkCode, repeat = 1) {
    if (!isWindows()) {
      return false;
    }

    const presses = Math.max(1, repeat);
    const script = [
      'Add-Type -TypeDefinition @"',
      "using System;",
      "using System.Runtime.InteropServices;",
      "public static class MediaKeySender {",
      "  [StructLayout(LayoutKind.Sequential)]",
      "  struct INPUT {",
      "    public int type;",
      "    public InputUnion u;",
      "  }",
      "  [StructLayout(LayoutKind.Explicit)]",
      "  struct InputUnion {",
      "    [FieldOffset(0)] public KEYBDINPUT ki;",
      "  }",
      "  [StructLayout(LayoutKind.Sequential)]",
      "  struct KEYBDINPUT {",
      "    public ushort wVk;",
      "    public ushort wScan;",
      "    public uint dwFlags;",
      "    public uint time;",
      "    public IntPtr dwExtraInfo;",
      "  }",
      '  [DllImport("user32.dll", SetLastError = true)]',
      "  static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);",
      "  const int INPUT_KEYBOARD = 1;",
      "  const uint KEYEVENTF_KEYUP = 0x0002;",
      "  const uint KEYEVENTF_EXTENDEDKEY = 0x0001;",
      "  public static void Send(ushort key) {",
      "    INPUT[] inputs = new INPUT[2];",
      "    inputs[0].type = INPUT_KEYBOARD;",
      "    inputs[0].u.ki = new KEYBDINPUT { wVk = key, dwFlags = KEYEVENTF_EXTENDEDKEY };",
      "    inputs[1].type = INPUT_KEYBOARD;",
      "    inputs[1].u.ki = new KEYBDINPUT { wVk = key, dwFlags = KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP };",
      "    SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));",
      "  }",
      "}",
      '"@',
      `[MediaKeySender]::Send([ushort]${vkCode})`,
      ...Array.from(
        { length: presses - 1 },
        () => `[MediaKeySender]::Send([ushort]${vkCode})`,
      ),
    ].join("\n");

    await this.runWindowsPowerShell(script, "spotify-media-key");
    return true;
  }

  async readWindowsMediaSession() {
    if (!isWindows()) {
      return null;
    }

    const script = [
      '$ErrorActionPreference = "Stop"',
      "Add-Type -AssemblyName System.Runtime.WindowsRuntime",
      "$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]",
      "$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType=WindowsRuntime]",
      "$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType=WindowsRuntime]",
      "$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType=WindowsRuntime]",
      "function AwaitOperation($operation, [Type] $resultType) {",
      "  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1",
      "  $task = $method.MakeGenericMethod($resultType).Invoke($null, @($operation))",
      "  $task.Wait()",
      "  return $task.Result",
      "}",
      "$manager = AwaitOperation ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])",
      "$sessions = @($manager.GetSessions())",
      "$session = $sessions | Where-Object { $_.SourceAppUserModelId -match 'Spotify' } | Select-Object -First 1",
      "if ($null -eq $session) { $session = $manager.GetCurrentSession() }",
      "if ($null -eq $session) { @{ active = $false } | ConvertTo-Json -Compress; exit }",
      "$props = AwaitOperation ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])",
      "$playbackInfo = $session.GetPlaybackInfo()",
      "$timeline = $session.GetTimelineProperties()",
      "$status = if ($null -ne $playbackInfo) { $playbackInfo.PlaybackStatus.ToString() } else { 'Unknown' }",
      "$thumbnailDataUrl = ''",
      "try {",
      "  if ($null -ne $props.Thumbnail) {",
      "    $stream = AwaitOperation ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])",
      "    $reader = [Windows.Storage.Streams.DataReader]::new($stream)",
      "    $size = [uint32]$stream.Size",
      "    $loaded = AwaitOperation ($reader.LoadAsync($size)) ([uint32])",
      "    $bytes = New-Object byte[] $loaded",
      "    $reader.ReadBytes($bytes)",
      "    $contentType = if ($stream.ContentType) { $stream.ContentType } else { 'image/jpeg' }",
      "    $thumbnailDataUrl = 'data:' + $contentType + ';base64,' + [Convert]::ToBase64String($bytes)",
      "    $reader.Dispose()",
      "    $stream.Dispose()",
      "  }",
      "} catch { $thumbnailDataUrl = '' }",
      "@{",
      "  active = $true",
      "  title = [string]$props.Title",
      "  artist = [string]$props.Artist",
      "  albumArt = [string]$thumbnailDataUrl",
      "  albumTitle = [string]$props.AlbumTitle",
      "  playbackStatus = [string]$status",
      "  positionMs = if ($null -ne $timeline) { [int64][Math]::Round($timeline.Position.TotalMilliseconds) } else { 0 }",
      "  endTimeMs = if ($null -ne $timeline) { [int64][Math]::Round($timeline.EndTime.TotalMilliseconds) } else { 0 }",
      "  sourceApp = [string]$session.SourceAppUserModelId",
      "} | ConvertTo-Json -Compress",
    ].join("\n");

    const output = await this.runWindowsPowerShell(
      script,
      "spotify-media-state",
      10000,
    );
    const jsonLine = String(output || "")
      .split(/\r?\n/)
      .filter(Boolean)
      .pop();
    if (!jsonLine) {
      return null;
    }

    const data = JSON.parse(jsonLine);
    if (!data.active) {
      return null;
    }

    const title = String(data.title || "").trim();
    const artist = String(data.artist || "").trim();
    if (!title && !artist) {
      return null;
    }

    return {
      title: title || "No song playing",
      artist: artist || "Unknown artist",
      albumArt: String(data.albumArt || "").trim(),
      playing: String(data.playbackStatus || "").toLowerCase() === "playing",
      progressMs: Math.max(0, Number(data.positionMs) || 0),
      durationMs: Math.max(0, Number(data.endTimeMs) || 0),
      deviceName: String(data.sourceApp || "Windows media session"),
      deviceType: "Windows media session",
      source: "windows-media-session",
    };
  }

  async controlWindowsMediaSession(action) {
    if (!isWindows()) {
      return false;
    }

    const methodByAction = {
      "play-pause": "TryTogglePlayPauseAsync",
      "next-track": "TrySkipNextAsync",
      "previous-track": "TrySkipPreviousAsync",
    };
    const methodName = methodByAction[action];
    if (!methodName) {
      return false;
    }

    const script = [
      '$ErrorActionPreference = "Stop"',
      "Add-Type -AssemblyName System.Runtime.WindowsRuntime",
      "$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]",
      "function AwaitOperation($operation, [Type] $resultType) {",
      "  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1",
      "  $task = $method.MakeGenericMethod($resultType).Invoke($null, @($operation))",
      "  $task.Wait()",
      "  return $task.Result",
      "}",
      "$manager = AwaitOperation ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])",
      "$sessions = @($manager.GetSessions())",
      "$session = $sessions | Where-Object { $_.SourceAppUserModelId -match 'Spotify' } | Select-Object -First 1",
      "if ($null -eq $session) { $session = $manager.GetCurrentSession() }",
      "if ($null -eq $session) { throw 'No active Windows media session. Open Spotify Desktop and start a song first.' }",
      `$operation = $session.${methodName}()`,
      "$result = AwaitOperation $operation ([bool])",
      "if (-not $result) { throw 'Windows media session rejected the command.' }",
      "'ok'",
    ].join("\n");

    await this.runWindowsPowerShell(script, "spotify-media-control", 10000);
    return true;
  }

  async seekWindowsMediaSession(positionMs) {
    if (!isWindows()) {
      return false;
    }

    const target = Math.max(0, Math.round(positionMs));
    const ticks = Math.max(0, target * 10000);
    const script = [
      '$ErrorActionPreference = "Stop"',
      "Add-Type -AssemblyName System.Runtime.WindowsRuntime",
      "$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]",
      "function AwaitOperation($operation, [Type] $resultType) {",
      "  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1",
      "  $task = $method.MakeGenericMethod($resultType).Invoke($null, @($operation))",
      "  $task.Wait()",
      "  return $task.Result",
      "}",
      "$manager = AwaitOperation ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])",
      "$sessions = @($manager.GetSessions())",
      "$session = $sessions | Where-Object { $_.SourceAppUserModelId -match 'Spotify' } | Select-Object -First 1",
      "if ($null -eq $session) { $session = $manager.GetCurrentSession() }",
      "if ($null -eq $session) { throw 'No active Windows media session. Open Spotify Desktop and start a song first.' }",
      `$operation = $session.TryChangePlaybackPositionAsync([Int64]${ticks})`,
      "$result = AwaitOperation $operation ([bool])",
      "if (-not $result) { throw 'Windows media session rejected the seek request.' }",
      "'ok'",
    ].join("\n");

    await this.runWindowsPowerShell(script, "spotify-media-seek", 10000);
    return true;
  }

  async refreshBasicPlaybackState(options = {}) {
    const silent = Boolean(options.silent);
    this.state.basicControlsAvailable = isWindows();

    try {
      const media = await this.readWindowsMediaSession();
      if (media) {
        // Optimization: Skip artwork search if the track hasn't changed
        const trackChanged =
          this.state.title !== media.title ||
          this.state.artist !== media.artist;
        let art = isRenderableAlbumArt(media.albumArt)
          ? media.albumArt
          : this.state.albumArt || "";

        if (trackChanged && !art) {
          try {
            const publicArt = await this.searchPublicTrackArtwork(
              media.title,
              media.artist,
            );
            if (publicArt) art = publicArt;
          } catch {
            /* best-effort */
          }
        }

        this.state.playing = media.playing;
        this.state.title = media.title;
        this.state.artist = media.artist;
        this.state.albumArt = art;
        this.state.progressMs = Math.max(0, media.progressMs || 0);
        this.state.durationMs = Math.max(0, media.durationMs || 0);
        this.state.progressLabel = formatDuration(this.state.progressMs);
        this.state.durationLabel = formatDuration(this.state.durationMs);
        this.state.deviceName = media.deviceName;
        this.state.deviceType = media.deviceType;

        this.state.error = "";
        this.pushState();
        return media;
      }

      if (!this.state.authenticated) {
        this.state.playing = false;
        this.state.title = "No song playing";
        this.state.artist = "Spotify";
        this.state.albumArt = "";
        this.state.progressMs = 0;
        this.state.durationMs = 0;
        this.state.progressLabel = "0:00";
        this.state.durationLabel = "0:00";
        this.state.deviceName = isWindows()
          ? "Windows media controls"
          : "Open Spotify in browser";
        this.state.deviceType = isWindows() ? "Basic mode" : "Manual mode";
      }
      this.pushState();
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!silent) {
        this.state.error = message;
      }
      this.pushState();
      return null;
    }
  }

  async logout() {
    try {
      await this.saveRefreshToken("");
    } finally {
      this.session.accessToken = "";
      this.session.expiresAt = 0;
      this.session.user = null;
      this.pendingAuth = null;
      this.refreshing = null;
      this.state.authInProgress = false;
      this.state.product = "";
      this.state.playing = false;
      this.state.title = "No song playing";
      this.state.artist = "Spotify";
      this.state.albumArt = "";
      this.state.deviceName = "No active device";
      this.state.deviceType = "";
      this.state.deviceVolume = 70;
      this.state.volume = 70;
      this.state.error = "";
      this.state.lastAction = "Disconnected from Spotify";
      this.updateAuthState(false, "Not connected");
      this.pushState();
      vscode.window.showInformationMessage("Disconnected from Spotify.");
    }
  }

  updateAuthState(authenticated, authStatus) {
    this.state.authenticated = authenticated;
    this.state.authStatus = authStatus;
    this.updatePlaybackMode();
  }

  updatePlaybackMode() {
    const isPremium =
      this.state.authenticated && this.state.product === "premium";
    this.state.canControlPlayback = isPremium;
    this.state.basicControlsAvailable = isWindows();
    this.state.accountMode = !this.state.authenticated
      ? "desktop"
      : isPremium
        ? "premium"
        : "free-desktop";
    this.state.tierMessage = !this.state.authenticated
      ? "Basic controls use Windows media keys and do not require Spotify Premium."
      : isPremium
        ? "Premium detected. Direct Spotify controls are enabled, with desktop controls as fallback."
        : "Free account connected. Controls use basic media keys instead of Premium-only Spotify APIs.";
  }

  async ensureServer() {
    if (this.server) {
      return;
    }

    if (this._startingServer) {
      return this._startingServer;
    }

    this._startingServer = (async () => {
      const { redirectUri } = this.settings();
      const redirect = new URL(redirectUri);
      const port = Number(redirect.port || (redirect.protocol === "https:" ? 443 : 80));
      const expectedPath = redirect.pathname;

      this.server = http.createServer((req, res) => {
        try {
          const requestUrl = new URL(req.url || "/", redirectUri);
          if (requestUrl.pathname !== expectedPath) {
            res.statusCode = 404;
            res.end("Not found");
            return;
          }

          const error = requestUrl.searchParams.get("error");
          const code = requestUrl.searchParams.get("code");
          const state = requestUrl.searchParams.get("state");

          if (error) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(this.loginResponse(`Spotify login failed: ${error}`));
            void this.failAuth(`Spotify login failed: ${error}`);
            return;
          }

          if (!this.pendingAuth) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(
              this.loginResponse(
                "Spotify login could not be completed: the extension lost the pending login session. Click Connect again and do not reload the extension host while signing in.",
              ),
            );
            return;
          }

          if (!code) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(
              this.loginResponse(
                "Spotify login could not be completed: Spotify did not return an authorization code. Check that the redirect URI matches exactly.",
              ),
            );
            return;
          }

          if (state !== this.pendingAuth.state) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(
              this.loginResponse(
                "Login failed: state parameter mismatch. Please try connecting again.",
              ),
            );
            void this.failAuth(
              "OAuth state mismatch — login attempt rejected for security.",
            );
            return;
          }

          res.statusCode = 200;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(
            this.loginResponse(
              "Spotify is connected. You can return to VS Code.",
            ),
          );

          void this.finishAuth(code).catch((err) => {
            void this.failAuth(err instanceof Error ? err.message : String(err));
          });
        } catch (err) {
          res.statusCode = 500;
          res.end("Internal error");
          void this.failAuth(err instanceof Error ? err.message : String(err));
        }
      });

      try {
        await new Promise((resolve, reject) => {
          this.server.once("error", (err) => {
            this.server = null;
            reject(err);
          });
          this.server.listen(port, "127.0.0.1", resolve);
        });
      } finally {
        this._startingServer = null;
      }
    })();
    return this._startingServer;
  }

  loginResponse(message) {
    const safe = escapeHtml(message);
    return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Spotify Login</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0c1117;color:#f4f7fb;font-family:system-ui,sans-serif}.card{max-width:520px;padding:24px;margin:20px;border-radius:18px;background:#111827;border:1px solid rgba(255,255,255,.08)}p{margin:0;color:#9cb0c9;line-height:1.5}h1{margin:0 0 8px;font-size:20px}</style></head><body><div class="card"><h1>Spotify connection</h1><p>${safe}</p></div></body></html>`;
  }

  async startLogin() {
    const { clientId, redirectUri } = this.settings();
    if (!clientId) {
      vscode.window.showErrorMessage(
        "Set spotifyPlayer.clientId in VS Code settings or SPOTIFY_CLIENT_ID in your environment.",
      );
      this.pushState();
      return;
    }

    // Auto-reset stuck auth if more than 2 minutes have passed
    const now = Date.now();
    if (
      this.state.authInProgress &&
      this.state.authStartTime &&
      now - this.state.authStartTime > 120000
    ) {
      console.log("[Auth] Resetting stuck login attempt...");
      this.pendingAuth = null;
      this.state.authInProgress = false;
    }

    if (this.pendingAuth || this.state.authInProgress) {
      vscode.window.showInformationMessage(
        "Spotify login is already in progress. Finish the current browser sign-in first.",
      );
      this.pushState();
      return;
    }

    try {
      await this.ensureServer();
      const codeVerifier = randomString(96);
      const state = randomString(24);
      this.pendingAuth = { codeVerifier, state, redirectUri };
      this.state.authInProgress = true;
      this.state.authStartTime = Date.now();

      const authUrl = buildUrl(`${SPOTIFY_AUTH}/authorize`, {
        client_id: clientId,
        response_type: "code",
        redirect_uri: redirectUri,
        scope: DEFAULT_SCOPES.join(" "),
        code_challenge_method: "S256",
        code_challenge: challenge(codeVerifier),
        state,
        show_dialog: "true",
      });

      this.updateAuthState(false, "Waiting for Spotify sign-in");
      this.pushState();
      await vscode.env.openExternal(vscode.Uri.parse(authUrl));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state.authInProgress = false;
      this.pendingAuth = null;
      vscode.window.showErrorMessage(`Failed to start Spotify login: ${message}`);
      this.pushState();
    }
  }

  async finishAuth(code) {
    if (!this.pendingAuth) {
      throw new Error("No pending Spotify login.");
    }

    const { clientId } = this.settings();
    const body = new URLSearchParams({
      client_id: clientId,
      grant_type: "authorization_code",
      code,
      redirect_uri: this.pendingAuth.redirectUri,
      code_verifier: this.pendingAuth.codeVerifier,
    });

    const response = await fetch(`${SPOTIFY_AUTH}/api/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    if (!response.ok) {
      throw new Error(
        `Spotify token exchange failed: ${response.status} ${await response.text()}`,
      );
    }

    const data = await response.json();
    await this.applyTokenData(data);
    this.pendingAuth = null;
    this.state.authInProgress = false;
    this.updateAuthState(true, "Spotify connected");
    console.log("[Auth] Token exchange successful, pushing state.");
    this.pushState(); // Explicit force push
    vscode.window.showInformationMessage("Spotify connected successfully.");
    await this.refreshPlaybackState({ silent: true });
  }

  async failAuth(message) {
    this.pendingAuth = null;
    this.state.authInProgress = false;
    this.updateAuthState(false, message);
    this.state.error = message;
    this.pushState();
    vscode.window.showErrorMessage(message);
  }

  async applyTokenData(data) {
    this.session.accessToken = data.access_token;
    this.session.expiresAt =
      Date.now() + Math.max(0, (Number(data.expires_in) || 3600) - 60) * 1000;
    if (data.refresh_token) {
      await this.saveRefreshToken(data.refresh_token);
    }

    const me = await fetch(`${SPOTIFY_API}/me`, {
      headers: { Authorization: `Bearer ${this.session.accessToken}` },
    });
    if (me.ok) {
      this.session.user = await me.json();
      this.state.userName =
        this.session.user.display_name || this.session.user.id || "";
      this.state.product = this.session.user.product || "";
      this.state.error = "";
      this.updatePlaybackMode();
      this.pushState(); // Force UI update
    } else {
      const errorBody = await me.text().catch(() => "Unknown error");
      this.state.error = `Profile fetch failed (${me.status}): ${errorBody}`;
      this.state.product = "";
      this.updatePlaybackMode();
    }
  }

  async refreshAccessToken(silent = false) {
    if (this.refreshing) {
      return this.refreshing;
    }
    if (!this.session.refreshToken) {
      return "";
    }

    const { clientId } = this.settings();
    if (!clientId) {
      if (!silent) {
        vscode.window.showErrorMessage(
          "Set spotifyPlayer.clientId before connecting to Spotify.",
        );
      }
      return "";
    }

    this.refreshing = (async () => {
      const body = new URLSearchParams({
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: this.session.refreshToken,
      });

      const response = await fetch(`${SPOTIFY_AUTH}/api/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });

      if (!response.ok) {
        const text = await response.text();
        // If the refresh token is invalid/revoked (HTTP 400 or 401), clear the session
        if (response.status === 400 || response.status === 401) {
          console.warn("[Auth] Refresh token invalid. Clearing session.");
          void this.saveRefreshToken("");
          this.session.refreshToken = "";
          this.updateAuthState(false, "Session expired - Please reconnect");
        }
        throw new Error(
          `Spotify token refresh failed: ${response.status} ${text}`,
        );
      }

      const data = await response.json();
      await this.applyTokenData(data);
      const productLabel =
        this.session.user?.product === "premium"
          ? "Premium account"
          : this.session.user?.product === "free"
            ? "Free account"
            : "Spotify account";
      this.updateAuthState(
        true,
        this.session.user?.display_name
          ? `Connected as ${this.session.user.display_name} - ${productLabel}`
          : `Connected to Spotify - ${productLabel}`,
      );
      return this.session.accessToken;
    })();

    try {
      return await this.refreshing;
    } catch (error) {
      this.session.accessToken = "";
      if (!silent) {
        vscode.window.showErrorMessage(
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    } finally {
      this.refreshing = null;
    }
  }

  async accessToken() {
    if (this.session.accessToken && Date.now() < this.session.expiresAt) {
      return this.session.accessToken;
    }
    if (this.session.refreshToken) {
      return this.refreshAccessToken(true);
    }
    return "";
  }

  async api(pathname, options = {}) {
    const token = await this.accessToken();
    if (!token) {
      throw new Error("Connect to Spotify first.");
    }

    const url = new URL(`${SPOTIFY_API}${pathname}`);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const request = {
      method: options.method || "GET",
      headers: { Authorization: `Bearer ${token}` },
    };
    if (options.body !== undefined) {
      request.headers["Content-Type"] = "application/json";
      request.body = JSON.stringify(options.body);
    }

    let response = await fetch(url.toString(), request);
    if (response.status === 401 && this.session.refreshToken) {
      await this.refreshAccessToken(true);
      response = await fetch(url.toString(), {
        ...request,
        headers: {
          ...request.headers,
          Authorization: `Bearer ${this.session.accessToken}`,
        },
      });
    }
    return response;
  }

  async currentPlayback() {
    const response = await this.api("/me/player");
    if (response.status === 204) {
      return null;
    }
    if (!response.ok) {
      throw new Error(
        `Failed to load playback state: ${response.status} ${await response.text()}`,
      );
    }
    return response.json();
  }

  async currentTrack() {
    const response = await this.api("/me/player/currently-playing");
    if (response.status === 204) {
      return null;
    }
    if (!response.ok) {
      throw new Error(
        `Failed to load current track: ${response.status} ${await response.text()}`,
      );
    }
    return response.json();
  }

  async recentlyPlayed() {
    const response = await this.api("/me/player/recently-played?limit=1");
    if (!response.ok) {
      throw new Error(
        `Failed to load recently played tracks: ${response.status} ${await response.text()}`,
      );
    }
    const data = await response.json();
    const latest =
      Array.isArray(data.items) && data.items.length ? data.items[0] : null;
    if (!latest?.track) {
      return null;
    }
    return {
      item: latest.track,
      is_playing: false,
      device: null,
      source: "recently-played",
    };
  }

  async devices() {
    const response = await this.api("/me/player/devices");
    if (!response.ok) {
      throw new Error(
        `Failed to load devices: ${response.status} ${await response.text()}`,
      );
    }
    const data = await response.json();
    return Array.isArray(data.devices) ? data.devices : [];
  }

  async searchTrackArtwork(title, artist) {
    const queryParts = [title, artist].filter(
      (value) => typeof value === "string" && value.trim(),
    );
    if (!queryParts.length) {
      return "";
    }

    const queries = [
      `track:${title} artist:${artist}`,
      `${title} ${artist}`,
      title,
      artist,
    ].filter((value) => typeof value === "string" && value.trim());

    for (const query of queries) {
      const response = await this.api("/search", {
        query: {
          q: query,
          type: "track",
          limit: 10,
        },
      });

      if (!response.ok) {
        throw new Error(
          `Failed to search Spotify artwork: ${response.status} ${await response.text()}`,
        );
      }

      const data = await response.json();
      const items = Array.isArray(data?.tracks?.items) ? data.tracks.items : [];
      const normalizedTitle = String(title || "")
        .trim()
        .toLowerCase();
      const normalizedArtist = String(artist || "")
        .trim()
        .toLowerCase();

      const match =
        items.find((item) => {
          const itemTitle = String(item?.name || "")
            .trim()
            .toLowerCase();
          const itemArtists = Array.isArray(item?.artists)
            ? item.artists
                .map((entry) =>
                  String(entry?.name || "")
                    .trim()
                    .toLowerCase(),
                )
                .filter(Boolean)
            : [];
          const titleMatches =
            !normalizedTitle ||
            itemTitle.includes(normalizedTitle) ||
            normalizedTitle.includes(itemTitle);
          const artistMatches =
            !normalizedArtist ||
            itemArtists.some(
              (name) =>
                name.includes(normalizedArtist) ||
                normalizedArtist.includes(name),
            );
          return titleMatches && artistMatches;
        }) ||
        items.find((item) => trackAlbumArt(item)) ||
        items[0];

      const artwork = trackAlbumArt(match);
      if (artwork) {
        return artwork;
      }
    }

    return "";
  }

  async searchPublicTrackArtwork(title, artist) {
    const queryParts = [title, artist].filter(
      (value) => typeof value === "string" && value.trim(),
    );
    if (!queryParts.length) {
      return "";
    }

    const url = new URL("https://itunes.apple.com/search");
    url.searchParams.set("term", queryParts.join(" "));
    url.searchParams.set("media", "music");
    url.searchParams.set("entity", "song");
    url.searchParams.set("limit", "10");

    const response = await fetch(url.toString(), {
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to load public artwork: ${response.status} ${await response.text()}`,
      );
    }

    const data = await response.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    const normalizedTitle = String(title || "")
      .trim()
      .toLowerCase();
    const normalizedArtist = String(artist || "")
      .trim()
      .toLowerCase();

    const match =
      results.find((item) => {
        const itemTitle = String(item?.trackName || "")
          .trim()
          .toLowerCase();
        const itemArtist = String(item?.artistName || "")
          .trim()
          .toLowerCase();
        const titleMatches =
          !normalizedTitle ||
          itemTitle.includes(normalizedTitle) ||
          normalizedTitle.includes(itemTitle);
        const artistMatches =
          !normalizedArtist ||
          itemArtist.includes(normalizedArtist) ||
          normalizedArtist.includes(itemArtist);
        return titleMatches && artistMatches;
      }) || results[0];

    const artwork = String(
      match?.artworkUrl100 || match?.artworkUrl60 || "",
    ).trim();
    if (!artwork) {
      return "";
    }

    return artwork.replace(/\/[0-9]+x[0-9]+bb\./i, "/600x600bb.");
  }

  pickDevice(devices) {
    const preferred = this.settings().preferredDevices.map((item) =>
      item.toLowerCase(),
    );
    for (const name of preferred) {
      const match = devices.find((device) =>
        (device.name || "").toLowerCase().includes(name),
      );
      if (match) {
        return match;
      }
    }
    return (
      devices.find((device) => device.is_active && !device.is_restricted) ||
      devices.find((device) => !device.is_restricted) ||
      devices[0] ||
      null
    );
  }

  async activeDevice() {
    const devices = await this.devices();
    const device = this.pickDevice(devices);
    if (!device) {
      throw new Error(
        "No Spotify device is available. Open Spotify Desktop or the web player first.",
      );
    }
    if (!device.is_active) {
      throw new Error("Open Spotify on an active device first.");
    }
    return device;
  }

  async ensureDeviceForPlay() {
    const devices = await this.devices();
    const device = this.pickDevice(devices);
    if (!device) {
      throw new Error(
        "No Spotify device is available. Open Spotify Desktop or the web player first.",
      );
    }
    if (!device.is_active) {
      await this.api("/me/player", {
        method: "PUT",
        body: { device_ids: [device.id], play: false },
      });
    }
    return device;
  }

  async setSpotifyVolume(value) {
    const target = Math.max(0, Math.min(100, Math.round(value)));
    const device = await this.activeDevice();
    await this.api("/me/player/volume", {
      method: "PUT",
      query: { volume_percent: target, device_id: device.id },
    });
    this.state.volume = target;
    this.state.deviceVolume = target;
    this.state.error = "";
    this.pushState();
    this.scheduleRefresh(180);
  }

  async seekSpotify(positionMs) {
    const target = Math.max(0, Math.round(positionMs));
    await this.activeDevice();
    await this.api("/me/player/seek", {
      method: "PUT",
      query: { position_ms: target },
    });
    this.state.progressMs = target;
    this.state.progressLabel = formatDuration(target);
    this.state.error = "";
    this.pushState();
    this.scheduleRefresh(120);
  }

  async seekPosition(positionMs) {
    const target = Math.max(0, Math.round(positionMs));
    const cappedTarget =
      this.state.durationMs > 0
        ? Math.min(target, this.state.durationMs)
        : target;

    this.state.progressMs = cappedTarget;
    this.state.progressLabel = formatDuration(cappedTarget);
    this.state.error = "";
    this.pushState();

    if (this.state.canControlPlayback) {
      await this.seekSpotify(cappedTarget);
      return;
    }

    if (isWindows()) {
      await this.seekWindowsMediaSession(cappedTarget);
      this.state.error = "";
      this.pushState();
      this.scheduleRefresh(120);
      return;
    }

    throw new Error(
      "Seeking is only available for Spotify Premium or Windows desktop media session mode.",
    );
  }

  async setWindowsMasterVolume(value) {
    if (!isWindows()) {
      return false;
    }

    const target = Math.max(0, Math.min(100, Math.round(value)));
    const scalar = target / 100;
    const script = [
      'Add-Type -TypeDefinition @"',
      "using System;",
      "using System.Runtime.InteropServices;",
      '[Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
      "interface IMMDeviceEnumerator {",
      "  int NotImpl1();",
      "  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);",
      "}",
      '[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
      "interface IMMDevice {",
      "  int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, out IAudioEndpointVolume ppInterface);",
      "}",
      '[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
      "interface IAudioEndpointVolume {",
      "  int RegisterControlChangeNotify(IntPtr pNotify);",
      "  int UnregisterControlChangeNotify(IntPtr pNotify);",
      "  int GetChannelCount(out uint pnChannelCount);",
      "  int SetMasterVolumeLevel(float fLevelDB, Guid pguidEventContext);",
      "  int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);",
      "  int GetMasterVolumeLevel(out float pfLevelDB);",
      "  int GetMasterVolumeLevelScalar(out float pfLevel);",
      "  int SetChannelVolumeLevel(uint nChannel, float fLevelDB, Guid pguidEventContext);",
      "  int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, Guid pguidEventContext);",
      "  int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);",
      "  int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);",
      "  int SetMute(bool bMute, Guid pguidEventContext);",
      "  int GetMute(out bool pbMute);",
      "  int GetVolumeStepInfo(out uint pnStep, out uint pnStepCount);",
      "  int VolumeStepUp(Guid pguidEventContext);",
      "  int VolumeStepDown(Guid pguidEventContext);",
      "  int QueryHardwareSupport(out uint pdwHardwareSupportMask);",
      "  int GetVolumeRange(out float pflVolumeMindB, out float pflVolumeMaxdB, out float pflVolumeIncrementdB);",
      "}",
      '[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"), ClassInterface(ClassInterfaceType.None)]',
      "class MMDeviceEnumeratorComObject { }",
      "public static class VolumeSetter {",
      "  public static void Set(float level) {",
      "    IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());",
      "    IMMDevice device;",
      "    Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out device));",
      "    Guid iid = typeof(IAudioEndpointVolume).GUID;",
      "    IAudioEndpointVolume volume;",
      "    Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out volume));",
      "    Guid context = Guid.Empty;",
      "    Marshal.ThrowExceptionForHR(volume.SetMasterVolumeLevelScalar(level, context));",
      "  }",
      "}",
      '"@',
      `[VolumeSetter]::Set([float]${scalar})`,
    ].join("\n");

    await this.runWindowsPowerShell(script, "spotify-master-volume", 10000);
    this.state.deviceVolume = target;
    this.state.volume = target;
    this.state.error = "";
    this.pushState();
    return true;
  }

  async setSpotifyAppVolume(value) {
    if (!isWindows()) {
      return false;
    }

    const target = Math.max(0, Math.min(100, Math.round(value)));
    const scalar = target / 100;
    const script = [
      'Add-Type -TypeDefinition @"',
      "using System;",
      "using System.Diagnostics;",
      "using System.Runtime.InteropServices;",
      '[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"), ClassInterface(ClassInterfaceType.None)]',
      "class MMDeviceEnumeratorComObject { }",
      '[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
      "interface IMMDeviceEnumerator {",
      "  int EnumAudioEndpoints(int dataFlow, int dwStateMask, IntPtr ppDevices);",
      "  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);",
      "  int GetDevice(string pwstrId, out IMMDevice ppDevice);",
      "  int RegisterEndpointNotificationCallback(IntPtr pClient);",
      "  int UnregisterEndpointNotificationCallback(IntPtr pClient);",
      "}",
      '[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
      "interface IMMDevice {",
      "  int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, out IAudioSessionManager2 ppInterface);",
      "}",
      '[Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
      "interface IAudioSessionManager2 {",
      "  int GetAudioSessionControl(IntPtr AudioSessionGuid, int StreamFlags, out IntPtr SessionControl);",
      "  int GetSimpleAudioVolume(IntPtr AudioSessionGuid, int StreamFlags, out IntPtr AudioVolume);",
      "  int GetSessionEnumerator(out IAudioSessionEnumerator SessionEnum);",
      "  int RegisterSessionNotification(IntPtr SessionNotification);",
      "  int UnregisterSessionNotification(IntPtr SessionNotification);",
      "  int RegisterDuckNotification(string sessionID, IntPtr duckNotification);",
      "  int UnregisterDuckNotification(IntPtr duckNotification);",
      "}",
      '[Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
      "interface IAudioSessionEnumerator {",
      "  int GetCount(out int SessionCount);",
      "  int GetSession(int SessionCount, out IAudioSessionControl2 Session);",
      "}",
      '[Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
      "interface IAudioSessionControl2 {",
      "  int GetState(out int pRetVal);",
      "  int GetDisplayName(out IntPtr pRetVal);",
      "  int SetDisplayName(string Value, ref Guid EventContext);",
      "  int GetIconPath(out IntPtr pRetVal);",
      "  int SetIconPath(string Value, ref Guid EventContext);",
      "  int GetGroupingParam(out Guid pRetVal);",
      "  int SetGroupingParam(ref Guid Override, ref Guid EventContext);",
      "  int RegisterAudioSessionNotification(IntPtr NewNotifications);",
      "  int UnregisterAudioSessionNotification(IntPtr NewNotifications);",
      "  int GetSessionIdentifier(out IntPtr pRetVal);",
      "  int GetSessionInstanceIdentifier(out IntPtr pRetVal);",
      "  int GetProcessId(out uint pRetVal);",
      "  int IsSystemSoundsSession();",
      "  int SetDuckingPreference(bool optOut);",
      "}",
      '[Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
      "interface ISimpleAudioVolume {",
      "  int SetMasterVolume(float fLevel, ref Guid EventContext);",
      "  int GetMasterVolume(out float pfLevel);",
      "  int SetMute(bool bMute, ref Guid EventContext);",
      "  int GetMute(out bool pbMute);",
      "}",
      "public static class SpotifyAppVolume {",
      "  public static int Set(float level) {",
      "    IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());",
      "    IMMDevice device;",
      "    Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out device));",
      "    Guid iid = typeof(IAudioSessionManager2).GUID;",
      "    IAudioSessionManager2 manager;",
      "    Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out manager));",
      "    IAudioSessionEnumerator sessions;",
      "    Marshal.ThrowExceptionForHR(manager.GetSessionEnumerator(out sessions));",
      "    int count;",
      "    Marshal.ThrowExceptionForHR(sessions.GetCount(out count));",
      "    int changed = 0;",
      "    Guid context = Guid.Empty;",
      "    for (int i = 0; i < count; i++) {",
      "      IAudioSessionControl2 control;",
      "      Marshal.ThrowExceptionForHR(sessions.GetSession(i, out control));",
      "      uint pid;",
      "      if (control.GetProcessId(out pid) != 0 || pid == 0) continue;",
      "      string name = string.Empty;",
      "      try { name = Process.GetProcessById((int)pid).ProcessName; } catch { continue; }",
      '      if (name.IndexOf("Spotify", StringComparison.OrdinalIgnoreCase) >= 0) {',
      "        ISimpleAudioVolume volume = (ISimpleAudioVolume)control;",
      "        Marshal.ThrowExceptionForHR(volume.SetMasterVolume(level, ref context));",
      "        changed++;",
      "      }",
      "    }",
      "    return changed;",
      "  }",
      "}",
      '"@',
      `$changed = [SpotifyAppVolume]::Set([float]${scalar})`,
      "if ($changed -lt 1) { throw 'No Spotify audio session was found. Play a song in Spotify Desktop first.' }",
      "'ok'",
    ].join("\n");

    await this.runWindowsPowerShell(script, "spotify-app-volume", 10000);
    this.state.deviceVolume = target;
    this.state.volume = target;
    this.state.error = "";
    this.pushState();
    return true;
  }

  async setVolume(value) {
    if (this.state.canControlPlayback) {
      await this.setSpotifyVolume(value);
      return;
    }

    if (isWindows()) {
      const target = Math.max(0, Math.min(100, Math.round(value)));
      this.state.deviceVolume = target;
      this.state.volume = target;
      this.state.error = "";
      this.pushState();
      try {
        await this.setSpotifyAppVolume(target);
      } catch (error) {
        await this.setWindowsMasterVolume(target);
        this.state.error =
          error instanceof Error ? error.message : String(error);
        this.pushState();
      }
      this.scheduleRefresh(180);
      return;
    }

    await vscode.env.openExternal(vscode.Uri.parse("https://open.spotify.com"));
  }

  async basicPlaybackFallback() {
    try {
      if (isWindows()) {
        this.state.playing = !this.state.playing;
        this.state.error = "";
        this.pushState();
        try {
          await this.controlWindowsMediaSession("play-pause");
        } catch {
          await this.sendWindowsMediaKey(0xb3);
        }
      } else {
        await vscode.env.openExternal(
          vscode.Uri.parse("https://open.spotify.com"),
        );
      }
      this.state.error = "";
      this.pushState();
      this.scheduleRefresh(180);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state.error = message;
      this.pushState();
      vscode.window.showErrorMessage(message);
    }
  }

  async basicControlFallback(action) {
    const mapping = {
      "next-track": { key: 0xb0, label: "next-track" },
      "previous-track": { key: 0xb1, label: "previous-track" },
      "volume-up": { key: 0xaf, label: "volume-up" },
      "volume-down": { key: 0xae, label: "volume-down" },
    };

    const target = mapping[action];
    if (!target) {
      return false;
    }

    try {
      if (isWindows()) {
        this.state.error = "";
        this.pushState();
        if (action === "next-track" || action === "previous-track") {
          try {
            await this.controlWindowsMediaSession(action);
          } catch {
            await this.sendWindowsMediaKey(target.key);
          }
        } else {
          await this.sendWindowsMediaKey(target.key);
        }
      } else {
        await vscode.env.openExternal(
          vscode.Uri.parse("https://open.spotify.com"),
        );
      }
      this.state.error = "";
      this.pushState();
      this.scheduleRefresh(220);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state.error = message;
      this.pushState();
      vscode.window.showErrorMessage(message);
      return true;
    }
  }

  async dispatchAction(action) {
    try {
      const playbackActions = new Set([
        "play-pause",
        "next-track",
        "previous-track",
        "volume-up",
        "volume-down",
      ]);
      if (playbackActions.has(action)) {
        if (this.state.canControlPlayback) {
          switch (action) {
            case "play-pause": {
              const isPlaying = this.state.playing;
              if (isPlaying) {
                this.state.playing = false;
                this.state.error = "";
                this.pushState();
                await this.api("/me/player/pause", { method: "PUT" });
              } else {
                this.state.playing = true;
                this.state.error = "";
                this.pushState();
                await this.api("/me/player/play", { method: "PUT" });
              }
              this.pushState();
              this.scheduleRefresh(180);
              return;
            }
            case "next-track":
              this.state.error = "";
              this.pushState();
              await this.api("/me/player/next", { method: "POST" });
              this.pushState();
              this.scheduleRefresh(220);
              return;
            case "previous-track":
              this.state.error = "";
              this.pushState();
              await this.api("/me/player/previous", { method: "POST" });
              this.pushState();
              this.scheduleRefresh(220);
              return;
            case "volume-up":
              await this.setSpotifyVolume(
                Math.min(
                  100,
                  (this.state.deviceVolume || this.state.volume || 0) + 10,
                ),
              );
              return;
            case "volume-down":
              await this.setSpotifyVolume(
                Math.max(
                  0,
                  (this.state.deviceVolume || this.state.volume || 0) - 10,
                ),
              );
              return;
            default:
              break;
          }
        }

        if (action === "play-pause") {
          await this.basicPlaybackFallback();
          return;
        }
        if (action === "volume-up") {
          await this.setVolume(
            Math.min(
              100,
              (this.state.deviceVolume || this.state.volume || 0) + 10,
            ),
          );
          return;
        }
        if (action === "volume-down") {
          await this.setVolume(
            Math.max(
              0,
              (this.state.deviceVolume || this.state.volume || 0) - 10,
            ),
          );
          return;
        }
        await this.basicControlFallback(action);
        return;
      }

      switch (action) {
        case "toggle-voice":
          this.state.voiceActive = !this.state.voiceActive;
          this.state.lastAction = this.state.voiceActive
            ? "Voice control active"
            : "Voice control paused";
          this.broadcastMessage({ type: "control", action: "toggle-voice" });
          break;
        case "open-external":
          await vscode.env.openExternal(
            vscode.Uri.parse("https://open.spotify.com"),
          );
          this.state.lastAction = "Opened Spotify in browser";
          break;
        case "mini-mode":
          this.state.mode = this.state.mode === "mini" ? "sidebar" : "mini";
          this.state.lastAction = `Switched to ${this.state.mode} mode`;
          break;
        case "refresh":
          await this.refreshPlaybackState();
          return;
        case "connect":
          await this.startLogin();
          return;
        case "logout":
          await this.logout();
          return;
        default:
          this.state.lastAction = `Unknown action: ${action}`;
      }

      await this.refreshPlaybackState({ silent: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state.lastAction = message;
      this.state.error = message;
      this.pushState();
      vscode.window.showErrorMessage(message);
    }
  }

  async refreshPlaybackState(options = {}) {
    const silent = Boolean(options.silent);
    try {
      if (!this.session.refreshToken) {
        this.updateAuthState(false, "Not connected");
        await this.refreshBasicPlaybackState({ silent });
        return;
      }

      if (!this.session.accessToken || Date.now() >= this.session.expiresAt) {
        await this.refreshAccessToken(true);
      }

      const [playbackState, devices] = await Promise.all([
        this.currentPlayback().catch(() => null),
        this.state.canControlPlayback
          ? this.devices().catch(() => [])
          : Promise.resolve([]),
      ]);

      // Only hit the fallback endpoints when currentPlayback() returned nothing
      let trackState = null;
      let recentState = null;
      if (!playbackState) {
        [trackState, recentState] = await Promise.all([
          this.currentTrack().catch(() => null),
          this.recentlyPlayed().catch(() => null),
        ]);
      }

      const basicState =
        playbackState || trackState
          ? null
          : await this.readWindowsMediaSession().catch(() => null);
      const basicPlayback = basicState
        ? {
            item: {
              name: basicState.title,
              artists: [{ name: basicState.artist }],
              album: {
                images: basicState.albumArt
                  ? [{ url: basicState.albumArt }]
                  : [],
              },
            },
            is_playing: basicState.playing,
            device: {
              name: basicState.deviceName,
              type: basicState.deviceType,
              volume_percent: this.state.deviceVolume,
            },
            source: basicState.source,
          }
        : null;
      const playback =
        playbackState || trackState || basicPlayback || recentState;
      const source = playbackState
        ? "current-playback"
        : trackState
          ? "currently-playing"
          : basicPlayback
            ? "windows-media-session"
            : recentState
              ? "recently-played"
              : "none";
      const device = this.pickDevice(devices);
      const deviceVolume = this.state.canControlPlayback
        ? typeof device?.volume_percent === "number"
          ? device.volume_percent
          : this.state.deviceVolume
        : typeof playback?.device?.volume_percent === "number"
          ? playback.device.volume_percent
          : this.state.deviceVolume;
      this.state.product =
        this.session.user?.product || this.state.product || "";
      const productLabel =
        this.state.product === "premium"
          ? "Premium account"
          : this.state.product === "free"
            ? "Free account"
            : this.state.authenticated && !this.session.user
              ? "Checking status..."
              : "Spotify account";
      const authLabel = this.session.user?.display_name
        ? `Connected as ${this.session.user.display_name} - ${productLabel}`
        : this.state.authenticated && !this.session.user
          ? `Connected - ${productLabel}`
          : `Connected to Spotify - ${productLabel}`;
      this.state.authenticated = true;
      this.state.authStatus = authLabel;
      this.state.authInProgress = false;
      this.updatePlaybackMode();
      this.state.debugSource = source;

      if (playback) {
        const track = getTrackText(playback.item);
        let artSource = "none";
        let preferredAlbumArt = pickPreferredAlbumArt(
          trackAlbumArt(playbackState?.item),
          trackAlbumArt(trackState?.item),
          trackAlbumArt(recentState?.item),
          track.albumArt,
          basicState?.albumArt,
        );
        if (preferredAlbumArt) {
          artSource = preferredAlbumArt.startsWith("data:image/")
            ? "windows-thumbnail"
            : "spotify-image";
        }
        if (!preferredAlbumArt && this.session.accessToken) {
          preferredAlbumArt = await this.searchTrackArtwork(
            track.title,
            track.artist,
          ).catch(() => "");
          if (preferredAlbumArt) {
            artSource = "spotify-search";
          }
        }
        if (!preferredAlbumArt) {
          preferredAlbumArt = await this.searchPublicTrackArtwork(
            track.title,
            track.artist,
          ).catch(() => "");
          if (preferredAlbumArt) {
            artSource = "public-search";
          }
        }
        this.state.playing = Boolean(playback.is_playing);
        this.state.title = track.title;
        this.state.artist = track.artist;
        this.state.albumArt = preferredAlbumArt;
        this.state.progressMs = Math.max(
          0,
          Number(playback.progress_ms) ||
            Number(trackState?.progress_ms) ||
            Number(playbackState?.progress_ms) ||
            Number(basicState?.progressMs) ||
            0,
        );
        this.state.durationMs = Math.max(
          0,
          Number(playback.item?.duration_ms) ||
            Number(trackState?.item?.duration_ms) ||
            Number(playbackState?.item?.duration_ms) ||
            Number(basicState?.durationMs) ||
            0,
        );
        this.state.progressLabel = formatDuration(this.state.progressMs);
        this.state.durationLabel = formatDuration(this.state.durationMs);
        this.state.volume =
          typeof playback.device?.volume_percent === "number"
            ? playback.device.volume_percent
            : this.state.volume;
        this.state.deviceVolume =
          typeof playback.device?.volume_percent === "number"
            ? playback.device.volume_percent
            : deviceVolume;
        this.state.deviceName =
          playback.device?.name || device?.name || "No active device";
        this.state.deviceType = playback.device?.type || device?.type || "";
        if (playback.source === "recently-played") {
          this.state.lastAction =
            "Showing recently played track because live playback data was unavailable.";
        }
        this.state.debugSummary = [
          `source=${source}`,
          `playing=${Boolean(playback.is_playing)}`,
          `title=${track.title}`,
          `artist=${track.artist}`,
          `art=${this.state.albumArt ? "yes" : "no"}`,
          `artSource=${artSource}`,
          `device=${this.state.deviceName || "none"}`,
          `tier=${this.state.accountMode}`,
        ].join(" | ");
      } else {
        this.state.playing = false;
        this.state.title = "No song playing";
        this.state.artist = "Spotify";
        this.state.albumArt = "";
        this.state.progressMs = 0;
        this.state.durationMs = 0;
        this.state.progressLabel = "0:00";
        this.state.durationLabel = "0:00";
        this.state.deviceName =
          device?.name || playback?.device?.name || "No active device";
        this.state.deviceType = device?.type || playback?.device?.type || "";
        this.state.deviceVolume = deviceVolume;
        this.state.debugSummary = `source=${source} | no playable track payload | tier=${this.state.accountMode}`;
      }

      this.state.error = "";
      this.pushState();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state.error = message;
      this.state.lastAction = message;
      this.state.debugSource = "error";
      this.state.debugSummary = message;
      if (!silent) {
        vscode.window.showErrorMessage(message);
      }
      this.pushState();
    }
  }

  broadcastMessage(message) {
    const failedWebviews = [];
    for (const webview of this.webviews) {
      try {
        webview.postMessage(message);
      } catch (error) {
        // Webview might be disposed or disconnected
        console.warn(
          "Failed to broadcast to webview:",
          error instanceof Error ? error.message : String(error),
        );
        failedWebviews.push(webview);
      }
    }
    // Clean up failed webviews from the set to prevent future errors
    failedWebviews.forEach((webview) => this.webviews.delete(webview));
  }

  serializedState() {
    return {
      playing: this.state.playing,
      title: this.state.title,
      artist: this.state.artist,
      albumArt: this.state.albumArt,
      progressMs: this.state.progressMs,
      durationMs: this.state.durationMs,
      progressLabel: this.state.progressLabel,
      durationLabel: this.state.durationLabel,
      volume: this.state.volume,
      authenticated: this.state.authenticated,
      authStatus: this.state.authStatus,
      userName: this.state.userName,
      product: this.state.product,
      deviceName: this.state.deviceName,
      deviceType: this.state.deviceType,
      deviceVolume: this.state.deviceVolume,
      voiceActive: this.state.voiceActive,
      authInProgress: this.state.authInProgress,
      canControlPlayback: this.state.canControlPlayback,
      basicControlsAvailable: this.state.basicControlsAvailable,
      accountMode: this.state.accountMode,
      tierMessage: this.state.tierMessage,
      debugSource: this.state.debugSource,
      debugSummary: this.state.debugSummary,
      mode: this.state.mode,
      lastAction: this.state.lastAction,
      error: this.state.error,
    };
  }

  pushState() {
    if (this._pushTimer) return;
    this._pushTimer = setTimeout(() => {
      try {
        const payload = { type: "sync-state", state: this.serializedState() };
        this.broadcastMessage(payload);

        // Update status bar safely
        if (this.statusBar) {
          this.statusBar.text = `$(music) ${this.state.playing ? "Playing" : "Paused"}: ${this.state.title || "No song"} - ${this.state.artist || "Spotify"}`;
          this.statusBar.tooltip = [
            this.state.authStatus || "Not connected",
            this.state.tierMessage || "Loading tier info...",
            this.state.deviceName || "No device",
            `Volume: ${this.state.deviceVolume || this.state.volume || 0}%`,
            this.state.lastAction || "Ready",
          ]
            .filter(Boolean)
            .join("\n");
        }
      } catch (error) {
        console.error(
          "Error during pushState:",
          error instanceof Error ? error.message : String(error),
        );
      }
      this._pushTimer = null;
    }, 50);
  }

  openMiniPlayer() {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "spotifyPlayerMini",
      "Spotify Mini Player",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(path.dirname(this.templatePath)),
          vscode.Uri.file(path.dirname(this.stylePath)),
          vscode.Uri.file(path.dirname(this.scriptPath)),
        ],
      },
    );

    this.panel = panel;
    panel.onDidDispose(() => {
      this.webviews.delete(panel.webview);
      if (this.panel === panel) {
        this.panel = undefined;
      }
    });
    this.configureWebview(panel.webview, "mini");
    panel.reveal(vscode.ViewColumn.Beside, true);
  }

  configureWebview(webview, mode) {
    webview.options = {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.file(path.dirname(this.templatePath)),
        vscode.Uri.file(path.dirname(this.stylePath)),
        vscode.Uri.file(path.dirname(this.scriptPath)),
      ],
    };

    this.webviews.add(webview);
    webview.html = this.renderHtml(webview, mode);
    webview.onDidReceiveMessage((message) => void this.handleMessage(message));
    webview.postMessage({ type: "sync-state", state: this.serializedState() });
  }

  renderHtml(webview, mode) {
    const template = readTemplateCached(this.templatePath);
    const styleUri = webview.asWebviewUri(vscode.Uri.file(this.stylePath));
    const scriptUri = webview.asWebviewUri(vscode.Uri.file(this.scriptPath));
    const nonce = crypto.randomBytes(16).toString("hex");

    return template
      .replaceAll("{{cspSource}}", webview.cspSource)
      .replaceAll("{{nonce}}", nonce)
      .replaceAll("{{styleUri}}", styleUri.toString())
      .replaceAll("{{scriptUri}}", scriptUri.toString())
      .replaceAll("{{mode}}", mode);
  }

  handleMessage(message) {
    if (!message || typeof message !== "object") {
      return;
    }

    if (message.type === "ready") {
      this.pushState();
      return;
    }

    if (message.type === "control") {
      void this.dispatchAction(message.action);
      return;
    }

    if (
      message.type === "player-state" &&
      message.state &&
      typeof message.state.volume === "number"
    ) {
      void this.setVolume(
        Math.max(0, Math.min(100, Math.round(message.state.volume))),
      );
      return;
    }

    if (
      message.type === "player-state" &&
      message.state &&
      typeof message.state.seekMs === "number"
    ) {
      void this.seekPosition(message.state.seekMs);
      return;
    }

    if (
      message.type === "voice-command" &&
      typeof message.command === "string"
    ) {
      const normalized = message.command.toLowerCase();
      if (normalized.includes("play") || normalized.includes("pause")) {
        void this.dispatchAction("play-pause");
      } else if (normalized.includes("next")) {
        void this.dispatchAction("next-track");
      } else if (normalized.includes("previous")) {
        void this.dispatchAction("previous-track");
      } else if (normalized.includes("volume up")) {
        void this.dispatchAction("volume-up");
      } else if (normalized.includes("volume down")) {
        void this.dispatchAction("volume-down");
      } else {
        this.state.lastAction = `Voice command not recognized: ${message.command}`;
        this.pushState();
      }
      return;
    }

    if (message.type === "voice-state" && typeof message.active === "boolean") {
      this.state.voiceActive = message.active;
      this.state.lastAction = message.active
        ? "Voice control active"
        : "Voice control paused";
      this.pushState();
    }
  }
}

async function activate(context) {
  const controller = new SpotifyPlayerController(context);
  context.subscriptions.push(controller.statusBar);
  // Dispose the persistent PS shell when the extension is deactivated
  context.subscriptions.push({ dispose: () => psShell.dispose() });
  return controller;
}

function deactivate() {
  psShell.dispose();
}

module.exports = {
  activate,
  deactivate,
};
