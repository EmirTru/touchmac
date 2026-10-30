/**
 * app.js - Main Application Coordinator for Mobile Virtual Touchscreen
 * Manages webcam lifecycle, MediaPipe Hands pipeline, low-latency WebSocket connection,
 * rendering loop, and UI controls.
 */

(function () {
  const video = document.getElementById("webcam-video");
  const canvas = document.getElementById("render-canvas");
  const ctx = canvas.getContext("2d", { alpha: false });

  // UI Elements
  const wsDot = document.getElementById("ws-dot");
  const wsStatus = document.getElementById("ws-status");
  const pingVal = document.getElementById("ping-val");
  const fpsVal = document.getElementById("fps-val");
  const gestureBadge = document.getElementById("gesture-badge");
  const calibrationToast = document.getElementById("calibration-toast");
  const btnCalibration = document.getElementById("btn-calibration");
  const btnSettings = document.getElementById("btn-settings");
  const settingsModal = document.getElementById("settings-modal");
  const sheetClose = document.getElementById("sheet-close");
  const loadingScreen = document.getElementById("loading-screen");

  const modePinch = document.getElementById("mode-pinch");
  const modeTouch = document.getElementById("mode-touch");

  const sliderPinch = document.getElementById("slider-pinch");
  const sliderDepth = document.getElementById("slider-depth");
  const sliderSmoothing = document.getElementById("slider-smoothing");
  const sliderScroll = document.getElementById("slider-scroll");
  const sliderZoom = document.getElementById("slider-zoom");

  const valPinch = document.getElementById("val-pinch");
  const valDepth = document.getElementById("val-depth");
  const valSmoothing = document.getElementById("val-smoothing");
  const valScroll = document.getElementById("val-scroll");
  const valZoom = document.getElementById("val-zoom");
  const btnResetCalib = document.getElementById("btn-reset-calib");

  // WebSocket Manager
  let ws = null;
  let isConnected = false;
  let reconnectTimer = null;
  let lastPingTime = 0;
  let isScanningNetwork = false;

  async function probeHost(host, timeoutMs = 800) {
    return new Promise((resolve) => {
      let done = false;
      try {
        const testWs = new WebSocket(`wss://${host}/ws`);
        const timer = setTimeout(() => {
          if (!done) {
            done = true;
            try { testWs.close(); } catch (e) {}
            resolve(false);
          }
        }, timeoutMs);

        testWs.onopen = () => {
          if (!done) {
            done = true;
            clearTimeout(timer);
            try { testWs.close(); } catch (e) {}
            resolve(host);
          }
        };

        testWs.onerror = () => {
          if (!done) {
            done = true;
            clearTimeout(timer);
            resolve(false);
          }
        };
      } catch (e) {
        resolve(false);
      }
    });
  }

  async function autoDiscoverMacBook() {
    if (isScanningNetwork) return null;
    isScanningNetwork = true;
    wsStatus.textContent = "🔍 MacBook Aranıyor...";

    // 1. Try Bonjour .local address
    const bonjourCandidate = "Emir-MacBook-Air.local:8443";
    const bOk = await probeHost(bonjourCandidate, 1000);
    if (bOk) {
      isScanningNetwork = false;
      return bOk;
    }

    // 2. Try common subnets and IP ranges (Mac's current IP is prioritized: 192.168.1.102)
    const priorityIps = [
      "192.168.1.102", "192.168.1.101", "192.168.1.103", "192.168.1.100",
      "192.168.1.104", "192.168.1.105", "192.168.1.2", "192.168.1.3",
      "192.168.0.102", "192.168.0.100", "192.168.0.101", "10.0.0.102"
    ];

    for (let i = 0; i < priorityIps.length; i += 4) {
      const batch = priorityIps.slice(i, i + 4).map(ip => `${ip}:8443`);
      const results = await Promise.all(batch.map(h => probeHost(h, 900)));
      for (const res of results) {
        if (res) {
          isScanningNetwork = false;
          return res;
        }
      }
    }

    // 3. Wide scan across 192.168.1.X subnet (100 to 130)
    const wideRange = [];
    for (let n = 100; n <= 130; n++) {
      wideRange.push(`192.168.1.${n}:8443`);
    }
    for (let i = 0; i < wideRange.length; i += 6) {
      const batch = wideRange.slice(i, i + 6);
      const results = await Promise.all(batch.map(h => probeHost(h, 750)));
      for (const res of results) {
        if (res) {
          isScanningNetwork = false;
          return res;
        }
      }
    }

    isScanningNetwork = false;
    return null;
  }

  async function connectWebSocket() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    let targetHost = location.host;
    const urlParams = new URLSearchParams(location.search);

    if (urlParams.get("server")) {
      targetHost = urlParams.get("server");
      localStorage.setItem("mac_server_host", targetHost);
    } else {
      const savedHost = localStorage.getItem("mac_server_host");
      if (savedHost) {
        targetHost = savedHost;
      } else if (location.hostname.includes("github.io") || location.hostname.includes("vercel.app") || location.hostname === "") {
        // Automatic discovery for cloud hosted pages
        const found = await autoDiscoverMacBook();
        if (found) {
          targetHost = found;
          localStorage.setItem("mac_server_host", found);
          wsStatus.textContent = "✅ MacBook Bulundu";
        }
      }
    }

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${targetHost}/ws`;

    wsDot.className = "status-dot";
    wsStatus.textContent = isScanningNetwork ? "🔍 Aranıyor..." : "Bağlanıyor...";

    try {
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        isConnected = true;
        wsDot.className = "status-dot connected";
        wsStatus.textContent = "Bağlandı";
        console.log(`[✓] WebSocket connected to MacBook (${targetHost})`);
        startPingLoop();
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.t === "pong" && msg.ts) {
            const rtt = Math.round(performance.now() - msg.ts);
            pingVal.textContent = rtt;
          }
        } catch (e) {}
      };

      ws.onclose = () => {
        handleDisconnect();
      };

      ws.onerror = () => {
        handleDisconnect();
      };
    } catch (err) {
      handleDisconnect();
    }
  }

  function handleDisconnect() {
    isConnected = false;
    wsDot.className = "status-dot";
    wsStatus.textContent = "Yeniden Bağlanıyor...";
    pingVal.textContent = "--";

    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectWebSocket();
      }, 1500);
    }
  }

  function sendAction(actionObj) {
    if (isConnected && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(actionObj));
    }
  }

  function startPingLoop() {
    setInterval(() => {
      if (isConnected && ws && ws.readyState === WebSocket.OPEN) {
        lastPingTime = performance.now();
        ws.send(JSON.stringify({ t: "ping", ts: lastPingTime }));
      }
    }, 1500);
  }

  // Managers
  const calibration = new CalibrationManager(canvas);
  const gesture = new GestureEngine(calibration, sendAction);

  // FPS calculation
  let frameCount = 0;
  let lastFpsUpdate = performance.now();

  function updateFps() {
    frameCount++;
    const now = performance.now();
    const elapsed = now - lastFpsUpdate;
    if (elapsed >= 1000) {
      const currentFps = Math.round((frameCount * 1000) / elapsed);
      fpsVal.textContent = currentFps;
      frameCount = 0;
      lastFpsUpdate = now;
    }
  }

  function dismissLoading() {
    if (loadingScreen && loadingScreen.style.display !== "none") {
      loadingScreen.style.opacity = "0";
      setTimeout(() => {
        loadingScreen.style.display = "none";
      }, 300);
    }
  }

  // Camera Initialization (Optimized for wide-angle and vertical phone orientation)
  let availableCameras = [];
  let currentCameraIndex = 0;

  async function updateCameraList() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      availableCameras = devices.filter((d) => d.kind === "videoinput");
    } catch (e) {}
  }

  async function switchCamera() {
    await updateCameraList();
    if (availableCameras.length <= 1) {
      alert("Cihazınızda başka kamera veya ultra geniş açı lensi bulunamadı.");
      return;
    }
    currentCameraIndex = (currentCameraIndex + 1) % availableCameras.length;
    const nextDev = availableCameras[currentCameraIndex];
    console.log("[*] Switching camera to:", nextDev.label || nextDev.deviceId);

    if (video.srcObject) {
      video.srcObject.getTracks().forEach((t) => t.stop());
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          deviceId: { exact: nextDev.deviceId },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 60 },
        },
      });
      video.srcObject = stream;
      await video.play();
      resizeCanvas();
      calibration.initCorners(video.videoWidth, video.videoHeight);
    } catch (err) {
      console.warn("Camera switch error:", err);
    }
  }

  async function initCamera() {
    const isPortrait = window.innerHeight > window.innerWidth;
    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: isPortrait ? 720 : 1280, min: 480 },
        height: { ideal: isPortrait ? 1280 : 720, min: 480 },
        frameRate: { ideal: 60, min: 30 },
      },
    };

    // Safety fallback: Dismiss loading screen after 2.5s regardless
    setTimeout(dismissLoading, 2500);

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      video.srcObject = stream;

      await new Promise((resolve) => {
        video.onloadedmetadata = () => {
          video.play();
          dismissLoading();
          resolve();
        };
      });

      console.log(`[✓] Camera running: ${video.videoWidth}x${video.videoHeight}`);
      resizeCanvas();
      calibration.initCorners(video.videoWidth, video.videoHeight);
      await updateCameraList();

    } catch (err) {
      console.warn("Rear camera not available, falling back to any video source:", err);
      try {
        const fallbackStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        video.srcObject = fallbackStream;
        await video.play();
        dismissLoading();
        resizeCanvas();
        calibration.initCorners(video.videoWidth, video.videoHeight);
      } catch (fatalErr) {
        dismissLoading();
        alert("Kamera erişimi sağlanamadı! Lütfen tarayıcı izinlerini kontrol edin: " + fatalErr.message);
        throw fatalErr;
      }
    }
  }

  function resizeCanvas() {
    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;
    canvas.width = vw;
    canvas.height = vh;

    // Maintain exact aspect ratio without cropping (unzoomed)
    const videoRatio = vw / vh;
    const windowRatio = window.innerWidth / window.innerHeight;

    if (windowRatio > videoRatio) {
      canvas.style.height = "100%";
      canvas.style.width = `${window.innerHeight * videoRatio}px`;
    } else {
      canvas.style.width = "100%";
      canvas.style.height = `${window.innerWidth / videoRatio}px`;
    }
  }

  window.addEventListener("resize", () => {
    if (video.videoWidth) resizeCanvas();
  });

  // MediaPipe Hands Pipeline
  let lastLandmarks = null;
  let isHandsReady = false;

  const hands = new Hands({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
  });

  hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.65,
    minTrackingConfidence: 0.65,
  });

  hands.onResults((results) => {
    if (!isHandsReady) {
      isHandsReady = true;
      loadingScreen.style.opacity = "0";
      setTimeout(() => {
        loadingScreen.style.display = "none";
      }, 400);
    }

    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
      lastLandmarks = results.multiHandLandmarks[0];
      gesture.processHand(lastLandmarks, canvas.width, canvas.height);
    } else {
      lastLandmarks = null;
      gesture.reset();
    }

    // Update active badge in UI
    gestureBadge.textContent = gesture.telemetry.state;
    if (gesture.state === "TOUCH" || gesture.state === "DRAG") {
      gestureBadge.style.color = "#34c759";
      gestureBadge.style.borderColor = "#34c759";
    } else if (gesture.state === "SCROLL") {
      gestureBadge.style.color = "#bf5af2";
      gestureBadge.style.borderColor = "#bf5af2";
    } else if (gesture.state === "ZOOM") {
      gestureBadge.style.color = "#ff9f0a";
      gestureBadge.style.borderColor = "#ff9f0a";
    } else {
      gestureBadge.style.color = "#00f0ff";
      gestureBadge.style.borderColor = "rgba(0, 240, 255, 0.4)";
    }
  });

  // Render & Detection Loop
  let isSendingFrame = false;

  async function frameLoop() {
    updateFps();

    // Draw live webcam frame onto canvas
    if (video.readyState >= 2) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      // Draw calibration polygon & corner pins
      calibration.draw(ctx, video);

      // Draw hand skeleton & crosshair HUD
      if (lastLandmarks) {
        gesture.drawHUD(ctx, lastLandmarks, canvas.width, canvas.height);
      }

      // Send frame to MediaPipe if not currently busy
      if (!isSendingFrame) {
        isSendingFrame = true;
        hands.send({ image: video })
          .catch(() => {})
          .finally(() => {
            isSendingFrame = false;
          });
      }
    }

    requestAnimationFrame(frameLoop);
  }

  // UI Event Handlers
  function bindUI() {
    // Calibration Toggle
    btnCalibration.addEventListener("click", () => {
      calibration.isEditing = !calibration.isEditing;
      btnCalibration.classList.toggle("active", calibration.isEditing);
      calibrationToast.classList.toggle("active", calibration.isEditing);
    });

    // Interaction Modes
    modePinch.addEventListener("click", () => {
      gesture.interactionMode = "pinch";
      modePinch.classList.add("active");
      modeTouch.classList.remove("active");
    });

    modeTouch.addEventListener("click", () => {
      gesture.interactionMode = "depth";
      modeTouch.classList.add("active");
      modePinch.classList.remove("active");
    });

    // Settings Modal
    btnSettings.addEventListener("click", () => {
      settingsModal.classList.add("open");
    });

    sheetClose.addEventListener("click", () => {
      settingsModal.classList.remove("open");
    });

    settingsModal.addEventListener("click", (e) => {
      if (e.target === settingsModal) {
        settingsModal.classList.remove("open");
      }
    });

    // Sliders
    sliderPinch.addEventListener("input", (e) => {
      const val = parseFloat(e.target.value);
      gesture.pinchThreshold = val;
      valPinch.textContent = val.toFixed(2);
    });

    sliderDepth.addEventListener("input", (e) => {
      const val = parseFloat(e.target.value);
      gesture.touchZThreshold = val;
      valDepth.textContent = val.toFixed(2);
    });

    sliderSmoothing.addEventListener("input", (e) => {
      const val = parseFloat(e.target.value);
      gesture.filterAlpha = val;
      valSmoothing.textContent = val.toFixed(2);
    });

    sliderScroll.addEventListener("input", (e) => {
      const val = parseFloat(e.target.value);
      gesture.scrollSensitivity = val;
      valScroll.textContent = val;
    });

    sliderZoom.addEventListener("input", (e) => {
      const val = parseFloat(e.target.value);
      gesture.zoomSensitivity = val;
      valZoom.textContent = val;
    });

    const btnSwitchCamera = document.getElementById("btn-switch-camera");
    if (btnSwitchCamera) {
      btnSwitchCamera.addEventListener("click", switchCamera);
    }

    btnResetCalib.addEventListener("click", () => {
      if (confirm("Kalibrasyon varsayılan ayarlara sıfırlansın mı?")) {
        calibration.reset(video.videoWidth || 1280, video.videoHeight || 720);
        alert("Kalibrasyon sıfırlandı!");
      }
    });
  }

  // Bootstrap Application
  async function start() {
    bindUI();
    connectWebSocket();

    try {
      await initCamera();
      requestAnimationFrame(frameLoop);
    } catch (e) {
      console.error("Initialization failed:", e);
    }
  }

  window.addEventListener("DOMContentLoaded", start);
})();
