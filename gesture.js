/**
 * gesture.js - Real-time Hand Gesture Recognition Engine
 * Detects fingertip tracking, surface touch contact, precision air-pinch,
 * 2-finger scrolling, pinch-to-zoom, and right-clicks using MediaPipe landmarks.
 */

class GestureEngine {
  constructor(calibrationManager, onAction) {
    this.calibration = calibrationManager;
    this.onAction = onAction; // Callback to send WebSocket actions to MacBook

    // Mode: "pinch" (Vision Pro air-pinch) or "depth" (direct screen surface touch)
    this.interactionMode = "pinch";

    // Sensitivity thresholds (configurable via UI)
    this.pinchThreshold = 0.38;       // Normalized pinch distance
    this.touchZThreshold = -0.06;     // Depth threshold for direct surface touch
    this.scrollSensitivity = 35.0;     // Scroll speed multiplier
    this.zoomSensitivity = 15.0;       // Zoom speed multiplier

    // Gesture states
    this.state = "IDLE"; // IDLE, HOVER, TOUCH, DRAG, SCROLL, ZOOM
    this.isTouchActive = false;
    this.touchStartTime = 0;
    this.touchStartX = 0;
    this.touchStartY = 0;
    this.hasDragged = false;
    this.rightClickTriggered = false;

    // Movement history for scrolling & zooming
    this.prevScrollX = null;
    this.prevScrollY = null;
    this.prevFingerDist = null;

    // Smoothing for landmark jitter
    this.smoothX = null;
    this.smoothY = null;
    this.smoothZ = null;
    this.filterAlpha = 0.45;

    // Live telemetry for HUD
    this.telemetry = {
      fps: 0,
      state: "IDLE",
      pinchDist: 0.0,
      zDepth: 0.0,
      normX: 0.5,
      normY: 0.5,
      screenMapped: false,
    };
  }

  reset() {
    if (this.isTouchActive) {
      this.isTouchActive = false;
      this.onAction({ t: "u", x: this.telemetry.normX, y: this.telemetry.normY, b: "left" });
    }
    this.state = "IDLE";
    this.prevScrollX = null;
    this.prevScrollY = null;
    this.prevFingerDist = null;
    this.smoothX = null;
    this.smoothY = null;
    this.smoothZ = null;
    this.hasDragged = false;
    this.rightClickTriggered = false;
  }

  /**
   * Main entry point called on each MediaPipe hand tracking frame.
   * landmarks: Array of 21 3D points {x, y, z} normalized to video dimensions.
   */
  processHand(landmarks, videoWidth, videoHeight) {
    if (!landmarks || landmarks.length < 21) {
      if (this.state !== "IDLE") this.reset();
      return;
    }

    // Convert key landmarks to pixel coordinates
    const pWrist = this.toPixel(landmarks[0], videoWidth, videoHeight);
    const pThumbTip = this.toPixel(landmarks[4], videoWidth, videoHeight);
    const pIndexMcp = this.toPixel(landmarks[5], videoWidth, videoHeight);
    const pIndexPip = this.toPixel(landmarks[6], videoWidth, videoHeight);
    const pIndexTip = this.toPixel(landmarks[8], videoWidth, videoHeight);
    const pMiddleTip = this.toPixel(landmarks[12], videoWidth, videoHeight);
    const pRingTip = this.toPixel(landmarks[16], videoWidth, videoHeight);
    const pPinkyTip = this.toPixel(landmarks[20], videoWidth, videoHeight);

    // Compute hand scale reference (Wrist to Index Knuckle distance)
    const handScale = Math.hypot(pIndexMcp.x - pWrist.x, pIndexMcp.y - pWrist.y) || 1.0;

    // Smooth Index Fingertip
    if (this.smoothX === null) {
      this.smoothX = pIndexTip.x;
      this.smoothY = pIndexTip.y;
      this.smoothZ = landmarks[8].z;
    } else {
      this.smoothX += this.filterAlpha * (pIndexTip.x - this.smoothX);
      this.smoothY += this.filterAlpha * (pIndexTip.y - this.smoothY);
      this.smoothZ += this.filterAlpha * (landmarks[8].z - this.smoothZ);
    }

    // Map Index Fingertip into MacBook Normalized Screen Space via Homography
    const screenCoord = this.calibration.toScreen(this.smoothX, this.smoothY);
    const u = Math.max(0.0, Math.min(1.0, screenCoord.u));
    const v = Math.max(0.0, Math.min(1.0, screenCoord.v));
    const isInsideScreen = screenCoord.u >= -0.08 && screenCoord.u <= 1.08 &&
                           screenCoord.v >= -0.08 && screenCoord.v <= 1.08;

    // Distances
    const thumbIndexDist = Math.hypot(pThumbTip.x - pIndexTip.x, pThumbTip.y - pIndexTip.y) / handScale;
    const indexMiddleDist = Math.hypot(pIndexTip.x - pMiddleTip.x, pIndexTip.y - pMiddleTip.y) / handScale;

    // Finger curls (check if ring & pinky are folded towards palm)
    const ringDistToWrist = Math.hypot(pRingTip.x - pWrist.x, pRingTip.y - pWrist.y) / handScale;
    const pinkyDistToWrist = Math.hypot(pPinkyTip.x - pWrist.x, pPinkyTip.y - pWrist.y) / handScale;
    const isRingPinkyCurled = (ringDistToWrist < 1.1 && pinkyDistToWrist < 1.0);

    // Relative depth to wrist
    const relDepthZ = landmarks[8].z - landmarks[0].z;

    // Update telemetry
    this.telemetry.pinchDist = thumbIndexDist;
    this.telemetry.zDepth = relDepthZ;
    this.telemetry.normX = u;
    this.telemetry.normY = v;
    this.telemetry.screenMapped = isInsideScreen;

    const now = performance.now();

    // ─────────────────────────────────────────────────────────────────────────────
    // GESTURE 1: TWO-FINGER SCROLL
    // Condition: Index & Middle fingers extended together, Ring & Pinky curled,
    // and not actively pinched.
    // ─────────────────────────────────────────────────────────────────────────────
    const isTwoFingerPointing = (indexMiddleDist < 0.42) && isRingPinkyCurled && (thumbIndexDist > 0.45);

    if (isTwoFingerPointing && !this.isTouchActive) {
      this.state = "SCROLL";
      this.telemetry.state = "SCROLLING (2-PARMAK)";

      const centerScrollX = (pIndexTip.x + pMiddleTip.x) * 0.5;
      const centerScrollY = (pIndexTip.y + pMiddleTip.y) * 0.5;

      if (this.prevScrollX !== null && this.prevScrollY !== null) {
        const dx = (centerScrollX - this.prevScrollX) / handScale;
        const dy = (centerScrollY - this.prevScrollY) / handScale;

        // Invert Y for natural scrolling (moving hand down scrolls down)
        const scrollDx = -dx * this.scrollSensitivity * 40.0;
        const scrollDy = dy * this.scrollSensitivity * 40.0;

        if (Math.hypot(scrollDx, scrollDy) > 2.0) {
          this.onAction({ t: "s", dx: scrollDx, dy: scrollDy });
        }
      }

      this.prevScrollX = centerScrollX;
      this.prevScrollY = centerScrollY;
      return;
    } else {
      this.prevScrollX = null;
      this.prevScrollY = null;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // GESTURE 2: TWO-FINGER PINCH-TO-ZOOM
    // Condition: When user moves Index and Middle fingers apart or together
    // ─────────────────────────────────────────────────────────────────────────────
    if (isRingPinkyCurled && indexMiddleDist >= 0.42 && indexMiddleDist <= 1.2 && !this.isTouchActive) {
      if (this.prevFingerDist !== null) {
        const deltaDist = (indexMiddleDist - this.prevFingerDist);
        if (Math.abs(deltaDist) > 0.015) {
          this.state = "ZOOM";
          this.telemetry.state = deltaDist > 0 ? "BÜYÜTME (ZOOM IN)" : "KÜÇÜLTME (ZOOM OUT)";
          this.onAction({ t: "z", delta: deltaDist * this.zoomSensitivity });
        }
      }
      this.prevFingerDist = indexMiddleDist;
      return;
    } else {
      this.prevFingerDist = null;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // GESTURE 3: TOUCH / CLICK / DRAG (POINTER INTERACTION)
    // ─────────────────────────────────────────────────────────────────────────────
    let isTouching = false;

    if (this.interactionMode === "pinch") {
      // Vision Pro style air-pinch
      isTouching = (thumbIndexDist < this.pinchThreshold);
    } else {
      // Direct screen touch surface (depth contact)
      isTouching = (relDepthZ < this.touchZThreshold);
    }

    if (isTouching) {
      if (!this.isTouchActive) {
        // Touch down event
        this.isTouchActive = true;
        this.touchStartTime = now;
        this.touchStartX = u;
        this.touchStartY = v;
        this.hasDragged = false;
        this.rightClickTriggered = false;
        this.state = "TOUCH";
        this.telemetry.state = "DOKUNMA (TOUCH DOWN)";

        this.onAction({ t: "d", x: u, y: v, b: "left" });
      } else {
        // Already touched: check drag vs long press right-click
        const distMoved = Math.hypot(u - this.touchStartX, v - this.touchStartY);

        if (distMoved > 0.012) {
          this.hasDragged = true;
          this.state = "DRAG";
          this.telemetry.state = "SÜRÜKLEME (DRAG)";
          this.onAction({ t: "m", x: u, y: v }); // Move during touch down triggers drag
        } else {
          // Check for long-press right click (held still for > 500ms)
          if (!this.rightClickTriggered && !this.hasDragged && (now - this.touchStartTime) > 500) {
            this.rightClickTriggered = true;
            this.state = "RIGHT_CLICK";
            this.telemetry.state = "SAĞ TIK (LONG PRESS)";
            // Release left touch and fire right click
            this.onAction({ t: "u", x: u, y: v, b: "left" });
            this.onAction({ t: "rc", x: u, y: v });
          } else {
            this.state = "TOUCH";
            this.telemetry.state = "BASILI TUTULUYOR";
          }
        }
      }
    } else {
      // Finger is not touching
      if (this.isTouchActive) {
        // Touch released
        this.isTouchActive = false;
        const touchDuration = now - this.touchStartTime;

        if (!this.rightClickTriggered) {
          this.onAction({ t: "u", x: u, y: v, b: "left" });

          // If quick tap (< 250ms) with virtually no movement, also ensure clean click
          if (touchDuration < 250 && !this.hasDragged) {
            this.telemetry.state = "TIKLAMA (TAP)";
          }
        }
      }

      // Hover / Move
      this.state = "HOVER";
      this.telemetry.state = isInsideScreen ? "İMLEYİCİ (HOVER)" : "EKRAN DIŞINDA";

      if (isInsideScreen) {
        this.onAction({ t: "m", x: u, y: v });
      }
    }
  }

  toPixel(lm, w, h) {
    return { x: lm.x * w, y: lm.y * h, z: lm.z };
  }

  /**
   * Renders skeletal bones and landmark points onto overlay canvas.
   */
  drawHUD(ctx, landmarks, videoWidth, videoHeight) {
    if (!landmarks || landmarks.length < 21) return;

    // Bone connection definitions
    const connections = [
      [0, 1], [1, 2], [2, 3], [3, 4],         // Thumb
      [0, 5], [5, 6], [6, 7], [7, 8],         // Index
      [0, 9], [9, 10], [10, 11], [11, 12],    // Middle
      [0, 13], [13, 14], [14, 15], [15, 16],  // Ring
      [0, 17], [17, 18], [18, 19], [19, 20],  // Pinky
      [5, 9], [9, 13], [13, 17],              // Palm
    ];

    // Pick glow color based on current gesture state
    let glowColor = "#00f0ff"; // Cyan for hover
    if (this.state === "TOUCH" || this.state === "DRAG") {
      glowColor = "#34c759";   // Green for touch/click
    } else if (this.state === "SCROLL") {
      glowColor = "#bf5af2";   // Purple for scroll
    } else if (this.state === "ZOOM") {
      glowColor = "#ff9f0a";   // Orange for zoom
    } else if (this.state === "RIGHT_CLICK") {
      glowColor = "#ff3b30";   // Red for right click
    }

    // Draw skeletal lines
    ctx.save();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
    ctx.beginPath();
    for (const [i, j] of connections) {
      const p1 = this.toPixel(landmarks[i], videoWidth, videoHeight);
      const p2 = this.toPixel(landmarks[j], videoWidth, videoHeight);
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
    }
    ctx.stroke();

    // Draw joints
    for (let i = 0; i < 21; i++) {
      const p = this.toPixel(landmarks[i], videoWidth, videoHeight);
      const isTip = (i === 4 || i === 8 || i === 12);

      ctx.beginPath();
      ctx.arc(p.x, p.y, isTip ? 7 : 4, 0, Math.PI * 2);
      ctx.fillStyle = isTip ? glowColor : "#ffffff";
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "#000000";
      ctx.stroke();
    }

    // Draw prominent crosshair and ripple on active Index Fingertip
    if (this.smoothX !== null && this.smoothY !== null) {
      ctx.beginPath();
      ctx.arc(this.smoothX, this.smoothY, this.isTouchActive ? 22 : 14, 0, Math.PI * 2);
      ctx.lineWidth = this.isTouchActive ? 3.5 : 2.0;
      ctx.strokeStyle = glowColor;
      ctx.shadowColor = glowColor;
      ctx.shadowBlur = 15;
      ctx.stroke();

      // State label above fingertip
      ctx.font = "bold 13px -apple-system, sans-serif";
      ctx.fillStyle = "#ffffff";
      ctx.shadowColor = "#000000";
      ctx.shadowBlur = 4;
      ctx.textAlign = "center";
      ctx.fillText(this.telemetry.state, this.smoothX, this.smoothY - 26);
    }

    ctx.restore();
  }
}

window.GestureEngine = GestureEngine;
