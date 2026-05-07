(function () {
  const vscode = acquireVsCodeApi();

  const els = {
    albumArt: document.getElementById("albumArt"),
    albumStageGlow: document.getElementById("albumStageGlow"),
    albumStageImage: document.getElementById("albumStageImage"),
    connectionDot: document.getElementById("connectionDot"),
    connectionText: document.getElementById("connectionText"),
    controlMode: document.getElementById("controlMode"),
    deviceName: document.getElementById("deviceName"),
    deviceType: document.getElementById("deviceType"),
    errorText: document.getElementById("errorText"),
    debugSource: document.getElementById("debugSource"),
    debugSummary: document.getElementById("debugSummary"),
    lastAction: document.getElementById("lastAction"),
    nextButton: document.getElementById("nextButton"),
    playPauseButton: document.getElementById("playPauseButton"),
    progressCurrent: document.getElementById("progressCurrent"),
    progressFill: document.getElementById("progressFill"),
    progressSeek: document.getElementById("progressSeek"),
    progressTotal: document.getElementById("progressTotal"),
    previousButton: document.getElementById("previousButton"),
    tierBanner: document.getElementById("tierBanner"),
    tierCopy: document.getElementById("tierCopy"),
    tierTitle: document.getElementById("tierTitle"),
    trackTitle: document.getElementById("trackTitle"),
    trackTitleMirror: document.getElementById("trackTitleMirror"),
    trackArtist: document.getElementById("trackArtist"),
    trackArtistMirror: document.getElementById("trackArtistMirror"),
    voiceButton: document.getElementById("voiceButton"),
    voiceToggle: document.getElementById("voiceToggle"),
    voiceText: document.getElementById("voiceText"),
    voiceStatus: document.getElementById("voiceStatus"),
    voiceDot: document.getElementById("voiceDot"),
    volume: document.getElementById("volume"),
    volumeValue: document.getElementById("volumeValue"),
    connectButton: document.getElementById("connectButton"),
    logoutButton: document.getElementById("logoutButton")
  };

  const state = {
    playing: false,
    title: "Connect to Spotify",
    artist: "Authorize the extension to control playback on your active device.",
    albumArt: "",
    progressMs: 0,
    durationMs: 0,
    progressLabel: "0:00",
    durationLabel: "0:00",
    volume: 70,
    authenticated: false,
    authStatus: "Waiting for Spotify sign-in",
    userName: "",
    product: "",
    deviceName: "No active device",
    deviceType: "Waiting for Spotify",
    deviceVolume: 70,
    voiceActive: false,
    authInProgress: false,
    canControlPlayback: false,
    basicControlsAvailable: true,
    accountMode: "signed-out",
    tierMessage: "",
    debugSource: "none",
    debugSummary: "No Spotify response yet.",
    mode: "sidebar",
    lastAction: "Ready",
    error: ""
  };

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let voiceShouldListen = false;
  let activeBackdrop = "";
  let volumeCommitTimer = null;
  let progressTimer = null;
  let progressAnchorMs = 0;
  let progressAnchorAt = 0;
  let isSeeking = false;
  let seekPreviewMs = 0;

  function post(type, payload = {}) {
    vscode.postMessage({ type, ...payload });
  }

  function formatTime(ms) {
    const safeMs = Math.max(0, Number(ms) || 0);
    const totalSeconds = Math.floor(safeMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  function isRenderableImage(value) {
    return typeof value === "string" && /^(https?:\/\/|data:image\/)/i.test(value.trim());
  }

  function effectiveProgressMs() {
    if (isSeeking) {
      return Math.max(0, Math.min(state.durationMs || 0, seekPreviewMs || 0));
    }
    if (!state.playing) {
      return Math.max(0, Math.min(state.durationMs || 0, progressAnchorMs || state.progressMs || 0));
    }

    const elapsed = Date.now() - progressAnchorAt;
    return Math.max(0, Math.min(state.durationMs || 0, (progressAnchorMs || state.progressMs || 0) + elapsed));
  }

  function renderProgress() {
    const duration = Math.max(0, Number(state.durationMs) || 0);
    const progress = effectiveProgressMs();
    const percent = duration > 0 ? Math.max(0, Math.min(100, (progress / duration) * 100)) : 0;
    els.progressCurrent.textContent = formatTime(progress);
    els.progressTotal.textContent = duration > 0 ? formatTime(duration) : (state.durationLabel || "0:00");
    els.progressFill.style.width = `${percent}%`;
    els.progressSeek.value = String(Math.round(percent * 10));
  }

  function syncProgressTicker() {
    progressAnchorMs = Math.max(0, Number(state.progressMs) || 0);
    progressAnchorAt = Date.now();
    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = null;
    }

    renderProgress();

    if (state.playing && (Number(state.durationMs) || 0) > 0) {
      progressTimer = setInterval(() => {
        renderProgress();
      }, 500);
    }
  }

  function applyBackdrop(imageUrl) {
    if (!isRenderableImage(imageUrl)) {
      activeBackdrop = "";
      els.albumStageImage.style.backgroundImage = "none";
      els.albumStageGlow.style.backgroundImage = "none";
      document.body.classList.remove("has-album-art");
      return;
    }

    if (imageUrl === activeBackdrop) {
      document.body.classList.add("has-album-art");
      return;
    }

    activeBackdrop = imageUrl;
    const safeUrl = imageUrl.replace(/(["\\])/g, "\\$1");
    els.albumStageImage.style.backgroundImage = `url("${safeUrl}")`;
    els.albumStageGlow.style.backgroundImage = `url("${safeUrl}")`;
    document.body.classList.add("has-album-art");
  }

  function syncUi() {
    const controlMode = state.canControlPlayback
      ? "Premium API mode"
      : (state.authenticated ? "Free desktop mode" : "Desktop mode");

    document.body.classList.toggle("is-playing", Boolean(state.playing));
    document.body.classList.toggle("premium-mode", Boolean(state.canControlPlayback));
    els.trackTitle.textContent = state.title || "No song playing";
    els.trackTitleMirror.textContent = state.title || "No song playing";
    els.trackArtist.textContent = state.artist || "Spotify";
    els.trackArtistMirror.textContent = state.artist || "Spotify";
    els.volume.value = String(state.deviceVolume ?? state.volume ?? 70);
    els.volumeValue.textContent = `${state.deviceVolume ?? state.volume ?? 70}%`;
    els.lastAction.textContent = state.lastAction || "Ready";
    els.connectionText.textContent = state.authenticated ? (state.authStatus || "Connected to Spotify") : "Basic controls ready";
    els.controlMode.textContent = controlMode;
    els.connectionDot.style.background = state.authenticated ? "var(--accent)" : "#667a90";
    els.deviceName.textContent = state.deviceName || "No active device";
    els.deviceType.textContent = state.deviceType || "Waiting for Spotify";
    els.errorText.textContent = state.error || "";
    els.debugSource.textContent = state.debugSource || "none";
    els.debugSummary.textContent = state.debugSummary || "No Spotify response yet.";
    els.tierBanner.classList.remove("hidden", "basic", "premium");
    if (state.authenticated && state.canControlPlayback) {
      els.tierBanner.classList.add("premium");
      els.tierTitle.textContent = "Premium API mode";
      els.tierCopy.textContent = state.tierMessage || "Direct Spotify controls are enabled.";
    } else {
      els.tierBanner.classList.add("basic");
      els.tierTitle.textContent = state.authenticated ? "Free desktop mode" : "Desktop mode ready";
      els.tierCopy.textContent = state.tierMessage || "Controls use system media keys, so Spotify Free works.";
    }
    els.voiceText.textContent = state.voiceActive ? "Listening for commands" : 'Say "Play music" or "Next song"';
    els.voiceStatus.textContent = state.voiceActive ? "Listening for commands." : "Idle";
    els.voiceDot.classList.toggle("live", state.voiceActive);
    document.body.classList.toggle("mode-mini", state.mode === "mini");

    if (isRenderableImage(state.albumArt)) {
      els.albumArt.src = state.albumArt;
      els.albumArt.style.opacity = "1";
      applyBackdrop(state.albumArt);
    } else {
      els.albumArt.removeAttribute("src");
      els.albumArt.style.opacity = "0.7";
      applyBackdrop("");
    }

    const voiceBtnText = els.voiceButton.querySelector(".btn-text");
    if (voiceBtnText) voiceBtnText.textContent = state.voiceActive ? "Stop voice control" : "Start voice control";
    
    const voiceToggleText = els.voiceToggle.querySelector(".btn-text");
    if (voiceToggleText) voiceToggleText.textContent = state.voiceActive ? "Voice On" : "Voice";
    
    // Toggle play/pause icon
    const playPauseIcon = els.playPauseButton.querySelector("svg");
    if (playPauseIcon) {
      if (state.playing) {
        playPauseIcon.innerHTML = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
      } else {
        playPauseIcon.innerHTML = '<path d="M8 5v14l11-7z"/>';
      }
    }

    const connectBtnText = els.connectButton.querySelector(".btn-text");
    if (connectBtnText) connectBtnText.textContent = state.authInProgress ? "Connecting..." : (state.authenticated ? "Reconnect" : "Connect");
    els.connectButton.disabled = state.authInProgress;
    els.logoutButton.disabled = !state.authenticated || state.authInProgress;
    els.previousButton.disabled = false;
    els.nextButton.disabled = false;
    els.playPauseButton.disabled = false;
    els.volume.disabled = false;
    syncProgressTicker();
  }

  function normalizeSpeech(text) {
    return text.toLowerCase().replace(/[^\w\s]/g, "").trim();
  }

  function handleVoiceCommand(text) {
    const command = normalizeSpeech(text);

    if (command.includes("play music") || command === "play music" || command.startsWith("play")) {
      post("voice-command", { command: "Play music" });
      return "Play music";
    }

    if (command.includes("pause music") || command === "pause music" || command.startsWith("pause")) {
      post("voice-command", { command: "Pause music" });
      return "Pause music";
    }

    if (command.includes("next song") || command.includes("next track") || command.startsWith("next")) {
      post("voice-command", { command: "Next song" });
      return "Next song";
    }

    if (command.includes("previous song") || command.includes("previous track") || command.includes("go back")) {
      post("voice-command", { command: "Previous song" });
      return "Previous song";
    }

    if (command.includes("volume up") || command.includes("louder")) {
      post("voice-command", { command: "Volume up" });
      return "Volume up";
    }

    if (command.includes("volume down") || command.includes("quieter")) {
      post("voice-command", { command: "Volume down" });
      return "Volume down";
    }

    return null;
  }

  function setVoiceListening(listening) {
    voiceShouldListen = listening;
    state.voiceActive = listening;
    syncUi();

    if (!SpeechRecognition) {
      els.voiceStatus.textContent = "Web Speech API is not available in this webview.";
      post("voice-state", { active: false });
      return;
    }

    if (listening) {
      if (!recognition) {
        recognition = new SpeechRecognition();
        recognition.lang = "en-US";
        recognition.continuous = false;
        recognition.interimResults = false;
        recognition.maxAlternatives = 1;

        recognition.onresult = (event) => {
          const transcript = event.results[0][0].transcript;
          const handled = handleVoiceCommand(transcript);
          els.voiceStatus.textContent = handled ? `Heard: ${handled}` : `Heard: ${transcript}`;
          if (handled) {
            state.lastAction = `Voice command: ${handled}`;
            syncUi();
          }
        };

        recognition.onerror = (event) => {
          els.voiceStatus.textContent = `Voice error: ${event.error}`;
          state.voiceActive = false;
          syncUi();
        };

        recognition.onend = () => {
          if (voiceShouldListen) {
            try {
              recognition.start();
              return;
            } catch (error) {
              voiceShouldListen = false;
            }
          }
          state.voiceActive = false;
          syncUi();
          post("voice-state", { active: false });
        };
      }

      try {
        recognition.start();
        els.voiceStatus.textContent = "Listening...";
        post("voice-state", { active: true });
      } catch (error) {
        els.voiceStatus.textContent = "Voice control could not start.";
        state.voiceActive = false;
        syncUi();
        post("voice-state", { active: false });
      }
      return;
    }

    if (recognition) {
      try {
        recognition.stop();
      } catch (error) {
        // Ignore stop races.
      }
    }

    post("voice-state", { active: false });
  }

  function wireControls() {
    document.querySelectorAll("[data-action]").forEach((button) => {
      button.addEventListener("click", () => {
        const action = button.getAttribute("data-action");
        if (action === "toggle-voice") {
          setVoiceListening(!state.voiceActive);
          return;
        }
        if (action === "play-pause") {
          state.playing = !state.playing;
        }
        state.lastAction = `Sending ${button.textContent.trim() || action}...`;
        syncUi();
        post("control", { action });
      });
    });

    els.volume.addEventListener("input", (event) => {
      const value = Number(event.target.value);
      state.deviceVolume = value;
      els.volumeValue.textContent = `${value}%`;
      state.lastAction = `Volume preview ${value}%`;
      syncUi();
      if (volumeCommitTimer) {
        clearTimeout(volumeCommitTimer);
      }
      volumeCommitTimer = setTimeout(() => {
        post("player-state", {
          state: { volume: value, lastAction: `Volume set to ${value}%` }
        });
        volumeCommitTimer = null;
      }, 140);
    });

    els.volume.addEventListener("change", (event) => {
      const value = Number(event.target.value);
      if (volumeCommitTimer) {
        clearTimeout(volumeCommitTimer);
        volumeCommitTimer = null;
      }
      post("player-state", {
        state: { volume: value, lastAction: `Volume set to ${value}%` }
      });
    });

    els.progressSeek.addEventListener("input", (event) => {
      const rawValue = Number(event.target.value);
      const duration = Math.max(0, Number(state.durationMs) || 0);
      isSeeking = true;
      seekPreviewMs = duration > 0 ? Math.round((rawValue / 1000) * duration) : 0;
      renderProgress();
    });

    els.progressSeek.addEventListener("change", (event) => {
      const rawValue = Number(event.target.value);
      const duration = Math.max(0, Number(state.durationMs) || 0);
      const seekMs = duration > 0 ? Math.round((rawValue / 1000) * duration) : 0;
      isSeeking = false;
      state.progressMs = seekMs;
      state.progressLabel = formatTime(seekMs);
      progressAnchorMs = seekMs;
      progressAnchorAt = Date.now();
      renderProgress();
      post("player-state", {
        state: { seekMs, lastAction: `Seeking to ${formatTime(seekMs)}` }
      });
    });

    els.voiceButton.addEventListener("click", () => {
      setVoiceListening(!state.voiceActive);
    });

    post("ready");
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || typeof message !== "object") {
      return;
    }

    if (message.type === "sync-state" && message.state) {
      Object.assign(state, message.state);
      syncUi();
      return;
    }

    if (message.type === "control" && message.action === "toggle-voice") {
      setVoiceListening(!state.voiceActive);
    }
  });

  els.albumArt.addEventListener("error", () => {
    els.albumArt.removeAttribute("src");
    els.albumArt.style.opacity = "0.7";
    applyBackdrop("");
  });

  wireControls();
  syncUi();
})();
