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
      if (els.albumStageImage) els.albumStageImage.style.backgroundImage = "none";
      if (els.albumStageGlow) els.albumStageGlow.style.backgroundImage = "none";
      document.body.classList.remove("has-album-art");
      return;
    }

    if (imageUrl === activeBackdrop) {
      document.body.classList.add("has-album-art");
      return;
    }

    activeBackdrop = imageUrl;
    // Properly escape and validate URL for CSS
    let safeUrl = "";
    try {
      const url = new URL(imageUrl);
      safeUrl = url.toString();
    } catch {
      // If URL parsing fails, escape manually but safely
      safeUrl = imageUrl.replace(/[\\'"]/g, "").trim();
    }
    if (els.albumStageImage) els.albumStageImage.style.backgroundImage = `url("${safeUrl}")`;
    if (els.albumStageGlow) els.albumStageGlow.style.backgroundImage = `url("${safeUrl}")`;
    document.body.classList.add("has-album-art");
  }

  let lastRenderedState = {};

  function syncUi() {
    // Optimization: Check for deep changes in a few key fields to avoid redundant work
    const stateKey = `${state.playing}-${state.title}-${state.artist}-${state.canControlPlayback}-${state.authenticated}-${state.mode}`;
    
    const controlMode = state.canControlPlayback
      ? "Premium API mode"
      : (state.authenticated ? "Free desktop mode" : "Desktop mode");

    if (lastRenderedState.playing !== state.playing) {
      document.body.classList.toggle("is-playing", Boolean(state.playing));
      const playPauseIcon = els.playPauseButton?.querySelector("svg");
      if (playPauseIcon) {
        playPauseIcon.innerHTML = state.playing 
          ? '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>' 
          : '<path d="M8 5v14l11-7z"/>';
      }
    }

    if (lastRenderedState.canControlPlayback !== state.canControlPlayback) {
      document.body.classList.toggle("premium-mode", Boolean(state.canControlPlayback));
    }

    if (lastRenderedState.title !== state.title) {
      if (els.trackTitle) els.trackTitle.textContent = state.title || "No song playing";
      if (els.trackTitleMirror) els.trackTitleMirror.textContent = state.title || "No song playing";
    }

    if (lastRenderedState.artist !== state.artist) {
      if (els.trackArtist) els.trackArtist.textContent = state.artist || "Spotify";
      if (els.trackArtistMirror) els.trackArtistMirror.textContent = state.artist || "Spotify";
    }

    const currentVolume = state.deviceVolume ?? state.volume ?? 70;
    if (lastRenderedState.volume !== currentVolume) {
      if (els.volume) els.volume.value = String(currentVolume);
      if (els.volumeValue) els.volumeValue.textContent = `${currentVolume}%`;
    }

    if (els.lastAction && lastRenderedState.lastAction !== state.lastAction) {
      els.lastAction.textContent = state.lastAction || "Ready";
    }

    if (els.controlMode && lastRenderedState.controlMode !== controlMode) {
      els.controlMode.textContent = controlMode;
    }

    if (lastRenderedState.albumArt !== state.albumArt) {
      if (els.albumArt) {
        if (isRenderableImage(state.albumArt)) {
          els.albumArt.src = state.albumArt;
          els.albumArt.style.opacity = "1";
          applyBackdrop(state.albumArt);
        } else {
          els.albumArt.removeAttribute("src");
          els.albumArt.style.opacity = "0.7";
          applyBackdrop("");
        }
      }
      
      // Throttle Chameleon Engine to avoid blocking the UI on rapid track changes
      if (state.albumArt && state.albumArt !== lastProcessedArt) {
        lastProcessedArt = state.albumArt;
        // Defer theme update and batch with requestIdleCallback for better performance
        if (window.requestIdleCallback) {
          window.requestIdleCallback(() => updateChameleonTheme(state.albumArt), { timeout: 2000 });
        } else {
          setTimeout(() => updateChameleonTheme(state.albumArt), 200);
        }
      }
    }

    document.body.classList.toggle("mode-mini", state.mode === "mini");
    document.body.classList.toggle("authenticated", Boolean(state.authenticated));

    if (els.connectButton) {
      els.connectButton.style.display = state.authenticated ? "none" : "flex";
    }
    if (els.logoutButton) {
      els.logoutButton.style.display = state.authenticated ? "flex" : "none";
    }

    // Update hero message for unauthenticated users
    if (!state.authenticated) {
      if (els.trackTitle) els.trackTitle.textContent = "Connect to Spotify";
      if (els.trackArtist) els.trackArtist.textContent = "Authorize the extension to control playback.";
    } else if (!state.title || state.title === "Connect to Spotify") {
      // Authenticated but no track playing
      if (els.trackTitle) els.trackTitle.textContent = state.userName ? `Welcome, ${state.userName}` : "Connected to Spotify";
      if (els.trackArtist) els.trackArtist.textContent = "Open Spotify and play a song to start.";
    }
    
    // Update local cache
    lastRenderedState = { ...state, volume: currentVolume, controlMode };
    
    // Trigger particles if in premium mode
    if (state.canControlPlayback) {
      initParticles();
    }
    
    syncProgressTicker();
  }

  let lastProcessedArt = "";
  let chameleonThrottleTimer = null;
  async function updateChameleonTheme(artUrl) {
    if (!artUrl || artUrl.includes('placeholder')) {
      resetThemeToDefault();
      return;
    }

    const img = new Image();
    // Use Anonymous crossOrigin to allow getImageData, but handle failures
    img.crossOrigin = "Anonymous";
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        console.warn("Canvas context unavailable for Chameleon theme");
        resetThemeToDefault();
        return;
      }
      canvas.width = 50; canvas.height = 50;
      
      try {
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
          try {
            document.documentElement.style.setProperty('--accent', color);
            document.documentElement.style.setProperty('--accent-glow', glow);
            document.documentElement.style.setProperty('--ambient-color', color);
          } catch (e) {
            console.warn("Failed to set CSS variables for theme:", e);
            resetThemeToDefault();
          }
        } else {
          resetThemeToDefault();
        }
      } catch (e) {
        console.warn("Chameleon extraction failed (likely CORS):", e);
        resetThemeToDefault();
      }
    };
    img.onerror = () => {
      console.warn("Failed to load album art for Chameleon theme:", artUrl);
      resetThemeToDefault();
    };
    img.src = artUrl;
  }

  function resetThemeToDefault() {
    try {
      const isPremium = state.authenticated && state.canControlPlayback;
      const color = isPremium ? '#8b5cf6' : '#1DB954';
      const glow = isPremium ? 'rgba(139, 92, 246, 0.5)' : 'rgba(29, 185, 84, 0.4)';
      document.documentElement.style.setProperty('--accent', color);
      document.documentElement.style.setProperty('--accent-glow', glow);
      document.documentElement.style.setProperty('--ambient-color', 'transparent');
    } catch (e) {
      console.error("Theme reset error:", e);
    }
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
    if (!navigator.mediaDevices?.getUserMedia) {
      els.voiceStatus.textContent = "Microphone access not available on this device.";
      return;
    }
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
      
      if (bars.length === 0) {
        console.warn("Voice bar elements not found in DOM");
        if (audioCtx) audioCtx.close();
        audioCtx = null;
        if (micStream) micStream.getTracks().forEach(t => t.stop());
        micStream = null;
        return;
      }

      function draw() {
        if (!state.voiceActive) return;
        visualizerId = requestAnimationFrame(draw);
        if (!analyser) return;
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
      els.voiceStatus.textContent = `Microphone access denied: ${err.name}. Please enable microphone permissions in your browser settings.`;
      state.voiceActive = false;
      syncUi();
      post("voice-state", { active: false });
    }
  }

  function stopVisualizer() {
    if (visualizerId) cancelAnimationFrame(visualizerId);
    visualizerId = null;
    
    if (audioCtx) {
      try {
        // Properly suspend context before closing to avoid hanging
        if (audioCtx.state === 'running') {
          audioCtx.suspend();
        }
        audioCtx.close();
      } catch(e) {
        console.warn("Error closing AudioContext:", e);
      }
      audioCtx = null;
    }
    if (micStream) {
      micStream.getTracks().forEach(t => {
        try { t.stop(); } catch(e) {}
      });
      micStream = null;
    }
    analyser = null;
    
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
      // Broadcast to all instances (extension.js will sync)
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
        // Sync voice state to extension for other webviews (sidebar/mini-player)
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
        // Ignore stop races and clean up state
      }
    }

    // Always notify extension of state change for sync across webviews
    post("voice-state", { active: false });
  }

  function wireControls() {
    // Use Event Delegation for maximum reliability
    document.addEventListener('click', (e) => {
      const button = e.target.closest('[data-action]');
      if (!button) return;

      const action = button.getAttribute("data-action");
      if (!action) return;

      e.preventDefault();
      e.stopPropagation();

      console.log(`[UI] Executing Action: ${action}`);
      
      if (action === "toggle-voice") {
        setVoiceListening(!state.voiceActive);
      } else if (action === "play-pause") {
        state.playing = !state.playing;
      }
      
      state.lastAction = `Sent: ${action}`;
      syncUi();
      post("control", { action });
    }, true); // Use capture phase to beat any animation overlays

    if (els.volume) {
      els.volume.oninput = (e) => {
        const value = Number(e.target.value);
        state.deviceVolume = value;
        if (els.volumeValue) els.volumeValue.textContent = `${value}%`;
        state.lastAction = `Volume preview: ${value}%`;
        syncUi();
        
        if (volumeCommitTimer) clearTimeout(volumeCommitTimer);
        volumeCommitTimer = setTimeout(() => {
          console.log(`[UI] Volume Commit (debounced): ${value}`);
          post("player-state", {
            state: { volume: value, lastAction: `Volume set to ${value}%` }
          });
          volumeCommitTimer = null;
        }, 350);
      };
      els.volume.onchange = (e) => {
        const value = Number(e.target.value);
        if (volumeCommitTimer) clearTimeout(volumeCommitTimer);
        console.log(`[UI] Volume Commit (manual): ${value}`);
        post("player-state", {
          state: { volume: value, lastAction: `Volume set to ${value}%` }
        });
        volumeCommitTimer = null;
      };
    }

    if (els.connectButton) {
      els.connectButton.onclick = () => {
        console.log("[UI] Manual Connect Call");
        post("control", { action: "connect" });
      };
    }

    if (els.progressSeek) {
      els.progressSeek.oninput = (e) => {
        isSeeking = true;
        const percent = Number(e.target.value) / 1000;
        seekPreviewMs = Math.round(percent * (state.durationMs || 0));
        renderProgress();
      };

      els.progressSeek.onchange = (e) => {
        isSeeking = false;
        const percent = Number(e.target.value) / 1000;
        const positionMs = Math.round(percent * (state.durationMs || 0));
        console.log(`[UI] Seek Commit: ${positionMs}ms`);
        post("player-state", { state: { seekMs: positionMs } });
        state.progressMs = positionMs;
        syncProgressTicker();
      };
    }

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
      try {
        createParticle();
      } catch (e) {
        console.warn("Failed to create particle:", e);
      }
    }
  }

  function createParticle() {
    const p = document.createElement("div");
    p.className = "particle";
    
    const size = Math.random() * 4 + 2;
    p.style.width = `${size}px`;
    p.style.height = `${size}px`;
    
    resetParticle(p);
    if (els.particles) els.particles.appendChild(p);
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

    try {
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
    } catch (e) {
      console.warn("Particle animation not supported:", e);
    }
  }

  try {
    wireControls();
    initTilt();
    console.log("Spotify Mini Player UI Initialized");
    document.body.classList.add("ready");
    syncUi();
  } catch (e) {
    console.error("Initialization failed:", e);
  }
})();
