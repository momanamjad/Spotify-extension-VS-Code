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
    logoutButton: document.getElementById("logoutButton"),
    particles: document.getElementById("particles")
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
  
  // Audio Visualizer State
  let audioCtx = null;
  let analyser = null;
  let micStream = null;
  let visualizerId = null;

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
      document.documentElement.style.setProperty('--accent', '#8b5cf6');
      document.documentElement.style.setProperty('--accent-glow', 'rgba(139, 92, 246, 0.5)');
    } else {
      els.tierBanner.classList.add("basic");
      els.tierTitle.textContent = state.authenticated ? "Free desktop mode" : "Desktop mode ready";
      els.tierCopy.textContent = state.tierMessage || "Controls use system media keys, so Spotify Free works.";
      document.documentElement.style.setProperty('--accent', '#1DB954');
      document.documentElement.style.setProperty('--accent-glow', 'rgba(29, 185, 84, 0.4)');
    }
    els.voiceText.textContent = state.voiceActive ? "Listening for commands" : 'Say "Play music" or "Next song"';
    els.voiceStatus.textContent = state.voiceActive ? "Listening..." : "Idle";
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
    
    els.debugSummary.textContent = "All components initialized. System OK.";
    
    if (state.albumArt !== lastProcessedArt) {
      lastProcessedArt = state.albumArt;
      updateChameleonTheme(state.albumArt);
    }
    
    syncProgressTicker();
  }

  let lastProcessedArt = "";
  async function updateChameleonTheme(artUrl) {
    if (!artUrl || artUrl.includes('placeholder')) {
      resetThemeToDefault();
      return;
    }

    const img = new Image();
    img.crossOrigin = "Anonymous";
    img.src = artUrl;
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      canvas.width = 50; canvas.height = 50; // Low-res for speed
      ctx.drawImage(img, 0, 0, 50, 50);
      
      const data = ctx.getImageData(0, 0, 50, 50).data;
      let r = 0, g = 0, b = 0, count = 0;
      
      // Sample vibrant pixels
      for (let i = 0; i < data.length; i += 16) {
        const pr = data[i], pg = data[i+1], pb = data[i+2];
        const brightness = (pr * 299 + pg * 587 + pb * 114) / 1000;
        if (brightness > 40 && brightness < 220) { // Avoid pure black/white
          r += pr; g += pg; b += pb; count++;
        }
      }
      
      if (count > 0) {
        r = Math.floor(r / count); g = Math.floor(g / count); b = Math.floor(b / count);
        // Boost saturation for neon effect
        const max = Math.max(r, g, b);
        const factor = 200 / max; 
        if (factor > 1) {
          r = Math.min(255, r * factor);
          g = Math.min(255, g * factor);
          b = Math.min(255, b * factor);
        }
        
        const color = `rgb(${r}, ${g}, ${b})`;
        const glow = `rgba(${r}, ${g}, ${b}, 0.5)`;
        document.documentElement.style.setProperty('--accent', color);
        document.documentElement.style.setProperty('--accent-glow', glow);
        document.documentElement.style.setProperty('--ambient-color', color);
      }
    };
  }

  function resetThemeToDefault() {
    const isPremium = state.authenticated && state.canControlPlayback;
    const color = isPremium ? '#8b5cf6' : '#1DB954';
    const glow = isPremium ? 'rgba(139, 92, 246, 0.5)' : 'rgba(29, 185, 84, 0.4)';
    document.documentElement.style.setProperty('--accent', color);
    document.documentElement.style.setProperty('--accent-glow', glow);
    document.documentElement.style.setProperty('--ambient-color', 'transparent');
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

  async function startVisualizer() {
    if (!navigator.mediaDevices?.getUserMedia) return;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      const source = audioCtx.createMediaStreamSource(micStream);
      source.connect(analyser);
      analyser.fftSize = 64;
      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      const bars = document.querySelectorAll('.voice-bar');

      function draw() {
        if (!state.voiceActive) return;
        visualizerId = requestAnimationFrame(draw);
        analyser.getByteFrequencyData(dataArray);
        
        let hasSound = false;
        for (let i = 0; i < bars.length; i++) {
          const index = Math.floor(i * (bufferLength / bars.length));
          const value = dataArray[index] || 0;
          if (value > 10) hasSound = true;
          
          // Boost sensitivity and use power for dramatic peaks
          const normalized = value / 255;
          const boosted = Math.pow(normalized, 0.8) * 40; 
          
          bars[i].style.height = `${Math.max(4, boosted)}px`;
          bars[i].classList.add('active');
          
          // Dynamic color based on intensity
          if (value > 150) {
            bars[i].style.background = '#fff';
            bars[i].style.boxShadow = `0 0 15px #fff`;
          } else {
            bars[i].style.background = '';
            bars[i].style.boxShadow = '';
          }
        }
        
        if (!hasSound) {
          // If silent, let them breathe slightly
          bars.forEach((b, i) => {
            const breathing = 4 + Math.sin(Date.now() / 200 + i) * 2;
            b.style.height = `${breathing}px`;
          });
        }
      }
      draw();
    } catch (err) {
      console.error("Microphone access for visualizer denied:", err);
    }
  }

  function stopVisualizer() {
    if (visualizerId) cancelAnimationFrame(visualizerId);
    if (audioCtx) {
      try { audioCtx.close(); } catch(e) {}
      audioCtx = null;
    }
    if (micStream) {
      micStream.getTracks().forEach(t => t.stop());
      micStream = null;
    }
    document.querySelectorAll('.voice-bar').forEach(b => {
      b.style.height = '4px';
      b.classList.remove('active');
    });
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
      startVisualizer();
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
        stopVisualizer();
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

  function initTilt() {
    const cards = document.querySelectorAll(".tilt-card");
    document.addEventListener("mousemove", (e) => {
      const { clientX, clientY } = e;
      const centerX = window.innerWidth / 2;
      const centerY = window.innerHeight / 2;
      
      cards.forEach(card => {
        const rect = card.getBoundingClientRect();
        const cardCenterX = rect.left + rect.width / 2;
        const cardCenterY = rect.top + rect.height / 2;

        // Update mouse position variables for CSS spotlight effect
        const x = clientX - rect.left;
        const y = clientY - rect.top;
        card.style.setProperty("--mouse-x", `${x}px`);
        card.style.setProperty("--mouse-y", `${y}px`);
        
        // Tilt based on mouse proximity to card center
        const tiltX = (clientY - cardCenterY) / 35;
        const tiltY = (cardCenterX - clientX) / 35;
        
        card.style.transform = `rotateX(${tiltX}deg) rotateY(${tiltY}deg) translateZ(10px)`;
      });
    });

    document.addEventListener("mouseleave", () => {
      cards.forEach(card => {
        card.style.transform = "rotateX(0deg) rotateY(0deg) translateZ(0px)";
      });
    });
  }

  let particlesRunning = false;
  function initParticles() {
    if (particlesRunning || !els.particles) return;
    particlesRunning = true;

    const count = 25;
    for (let i = 0; i < count; i++) {
      createParticle();
    }
  }

  function createParticle() {
    const p = document.createElement("div");
    p.className = "particle";
    
    const size = Math.random() * 4 + 2;
    p.style.width = `${size}px`;
    p.style.height = `${size}px`;
    
    resetParticle(p);
    els.particles.appendChild(p);
    animateParticle(p);
  }

  function resetParticle(p) {
    p.style.left = `${Math.random() * 100}%`;
    p.style.top = `${Math.random() * 100}%`;
    p.style.opacity = Math.random() * 0.4;
    p.style.transform = `scale(${Math.random() * 0.5 + 0.5})`;
  }

  function animateParticle(p) {
    const duration = Math.random() * 15000 + 10000;
    const xDist = (Math.random() - 0.5) * 200;
    const yDist = (Math.random() - 0.5) * 200;

    p.animate([
      { transform: `translate(0, 0) scale(1)`, opacity: p.style.opacity },
      { transform: `translate(${xDist}px, ${yDist}px) scale(1.5)`, opacity: 0.6 },
      { transform: `translate(${xDist * 2}px, ${yDist * 2}px) scale(1)`, opacity: 0 }
    ], {
      duration,
      iterations: Infinity,
      direction: "alternate",
      easing: "ease-in-out"
    });
  }

  wireControls();
  initTilt();
  
  // Only start particles if already in premium mode, 
  // otherwise they'll be started by syncUi when status changes
  if (state.canControlPlayback) {
    initParticles();
  }

  // Update syncUi to trigger particles
  const originalSyncUi = syncUi;
  syncUi = function() {
    originalSyncUi();
    if (state.canControlPlayback) {
      initParticles();
    }
  };

  syncUi();
})();
