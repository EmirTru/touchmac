/**
 * calibration.js - 4-Point Homography & Perspective Calibration Engine
 * Solves perspective warp from camera image space to normalized MacBook display coordinates (0..1, 0..1).
 * Features draggable corner pins with real-time magnifying loupe and localStorage persistence.
 */

class HomographySolver {
  constructor() {
    this.H = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    this.Hinv = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  }

  /**
   * Solves for 3x3 homography matrix H transforming src Quad -> dst Quad.
   * src: array of 4 {x, y} points in camera pixels.
   * dst: array of 4 {x, y} points in normalized screen (0..1, 0..1).
   */
  compute(src, dst) {
    const A = [];
    const b = [];

    for (let i = 0; i < 4; i++) {
      const sx = src[i].x;
      const sy = src[i].y;
      const dx = dst[i].x;
      const dy = dst[i].y;

      A.push([sx, sy, 1, 0, 0, 0, -dx * sx, -dx * sy]);
      b.push(dx);

      A.push([0, 0, 0, sx, sy, 1, -dy * sx, -dy * sy]);
      b.push(dy);
    }

    // Solve 8x8 linear system via Gaussian elimination with partial pivoting
    const h = this.solveGaussian(A, b);
    if (!h) {
      console.warn("Homography solver singular matrix, using identity");
      this.H = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      this.Hinv = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      return false;
    }

    this.H = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1.0];
    this.Hinv = this.invert3x3(this.H);
    return true;
  }

  solveGaussian(A, b) {
    const n = 8;
    // Augmented matrix
    for (let i = 0; i < n; i++) {
      A[i].push(b[i]);
    }

    for (let i = 0; i < n; i++) {
      // Find pivot
      let maxRow = i;
      let maxVal = Math.abs(A[i][i]);
      for (let k = i + 1; k < n; k++) {
        if (Math.abs(A[k][i]) > maxVal) {
          maxVal = Math.abs(A[k][i]);
          maxRow = k;
        }
      }
      if (maxVal < 1e-12) return null; // Singular

      // Swap rows
      const tmp = A[i];
      A[i] = A[maxRow];
      A[maxRow] = tmp;

      // Eliminate below
      for (let k = i + 1; k < n; k++) {
        const factor = A[k][i] / A[i][i];
        for (let j = i; j <= n; j++) {
          A[k][j] -= factor * A[i][j];
        }
      }
    }

    // Back-substitution
    const x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
      let sum = A[i][n];
      for (let j = i + 1; j < n; j++) {
        sum -= A[i][j] * x[j];
      }
      x[i] = sum / A[i][i];
    }
    return x;
  }

  invert3x3(m) {
    const det =
      m[0] * (m[4] * m[8] - m[5] * m[7]) -
      m[1] * (m[3] * m[8] - m[5] * m[6]) +
      m[2] * (m[3] * m[7] - m[4] * m[6]);

    if (Math.abs(det) < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const invdet = 1.0 / det;

    return [
      (m[4] * m[8] - m[5] * m[7]) * invdet,
      (m[2] * m[7] - m[1] * m[8]) * invdet,
      (m[1] * m[5] - m[2] * m[4]) * invdet,
      (m[5] * m[6] - m[3] * m[8]) * invdet,
      (m[0] * m[8] - m[2] * m[6]) * invdet,
      (m[2] * m[3] - m[0] * m[5]) * invdet,
      (m[3] * m[7] - m[4] * m[6]) * invdet,
      (m[1] * m[6] - m[0] * m[7]) * invdet,
      (m[0] * m[4] - m[1] * m[3]) * invdet,
    ];
  }

  /**
   * Transforms camera pixel point (x, y) into normalized screen coordinates (0..1, 0..1).
   */
  transform(x, y) {
    const w = this.H[6] * x + this.H[7] * y + this.H[8];
    if (Math.abs(w) < 1e-6) return { u: 0.5, v: 0.5, valid: false };
    return {
      u: (this.H[0] * x + this.H[1] * y + this.H[2]) / w,
      v: (this.H[3] * x + this.H[4] * y + this.H[5]) / w,
      valid: true,
    };
  }

  /**
   * Transforms normalized screen coordinates (u, v) back to camera pixel coordinates.
   */
  inverse(u, v) {
    const w = this.Hinv[6] * u + this.Hinv[7] * v + this.Hinv[8];
    if (Math.abs(w) < 1e-6) return { x: 0, y: 0 };
    return {
      x: (this.Hinv[0] * u + this.Hinv[1] * v + this.Hinv[2]) / w,
      y: (this.Hinv[3] * u + this.Hinv[4] * v + this.Hinv[5]) / w,
    };
  }
}

class CalibrationManager {
  constructor(canvas) {
    this.canvas = canvas;
    this.solver = new HomographySolver();
    this.isEditing = false;
    this.activePointIndex = -1;

    // Default normalized screen targets (Top-Left, Top-Right, Bottom-Right, Bottom-Left)
    this.screenTargets = [
      { x: 0.0, y: 0.0 },
      { x: 1.0, y: 0.0 },
      { x: 1.0, y: 1.0 },
      { x: 0.0, y: 1.0 },
    ];

    // Corner pin visual metadata
    this.cornerMeta = [
      { name: "TL (Sol Üst)", color: "#ff3b30", border: "#ff3b30" },
      { name: "TR (Sağ Üst)", color: "#34c759", border: "#34c759" },
      { name: "BR (Sağ Alt)", color: "#007aff", border: "#007aff" },
      { name: "BL (Sol Alt)", color: "#ffcc00", border: "#ffcc00" },
    ];

    // 4 Corner points in camera frame coordinates
    this.corners = [];
    this.storageKey = "mac_touchscreen_calibration_v1";

    this.bindTouchEvents();
  }

  initCorners(videoWidth, videoHeight) {
    const saved = localStorage.getItem(this.storageKey);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length === 4) {
          this.corners = parsed;
          this.updateHomography();
          return;
        }
      } catch (e) {
        console.warn("Failed to load saved calibration:", e);
      }
    }

    // Orientation-aware default trapezoid:
    // If phone is standing vertically (portrait), MacBook screen is wider horizontally and in middle band
    const isPortrait = videoHeight > videoWidth;
    if (isPortrait) {
      this.corners = [
        { x: videoWidth * 0.06, y: videoHeight * 0.35 }, // TL (Sol Üst)
        { x: videoWidth * 0.94, y: videoHeight * 0.33 }, // TR (Sağ Üst)
        { x: videoWidth * 0.96, y: videoHeight * 0.74 }, // BR (Sağ Alt)
        { x: videoWidth * 0.04, y: videoHeight * 0.76 }, // BL (Sol Alt)
      ];
    } else {
      const marginX = videoWidth * 0.15;
      const marginY = videoHeight * 0.15;
      this.corners = [
        { x: marginX, y: marginY },                             // TL
        { x: videoWidth - marginX, y: marginY * 1.1 },          // TR
        { x: videoWidth - marginX * 0.8, y: videoHeight - marginY }, // BR
        { x: marginX * 0.8, y: videoHeight - marginY },         // BL
      ];
    }
    this.updateHomography();
  }

  save() {
    localStorage.setItem(this.storageKey, JSON.stringify(this.corners));
    console.log("[✓] Calibration saved to localStorage");
  }

  reset(videoWidth, videoHeight) {
    localStorage.removeItem(this.storageKey);
    this.initCorners(videoWidth, videoHeight);
  }

  updateHomography() {
    if (this.corners.length === 4) {
      this.solver.compute(this.corners, this.screenTargets);
    }
  }

  /**
   * Projects camera coordinate (x, y) to screen normalized point (u, v).
   */
  toScreen(x, y) {
    return this.solver.transform(x, y);
  }

  isInsideScreen(x, y) {
    const pt = this.toScreen(x, y);
    return pt.u >= -0.05 && pt.u <= 1.05 && pt.v >= -0.05 && pt.v <= 1.05;
  }

  bindTouchEvents() {
    const handleStart = (clientX, clientY) => {
      if (!this.isEditing) return false;
      const rect = this.canvas.getBoundingClientRect();
      const scaleX = this.canvas.width / rect.width;
      const scaleY = this.canvas.height / rect.height;

      const canvasX = (clientX - rect.left) * scaleX;
      const canvasY = (clientY - rect.top) * scaleY;

      // Find closest corner pin within touch radius (50px)
      const touchRadius = 60 * scaleX;
      let closestIdx = -1;
      let minDist = touchRadius;

      for (let i = 0; i < 4; i++) {
        const d = Math.hypot(this.corners[i].x - canvasX, this.corners[i].y - canvasY);
        if (d < minDist) {
          minDist = d;
          closestIdx = i;
        }
      }

      if (closestIdx !== -1) {
        this.activePointIndex = closestIdx;
        return true;
      }
      return false;
    };

    const handleMove = (clientX, clientY) => {
      if (!this.isEditing || this.activePointIndex === -1) return;
      const rect = this.canvas.getBoundingClientRect();
      const scaleX = this.canvas.width / rect.width;
      const scaleY = this.canvas.height / rect.height;

      const canvasX = Math.max(0, Math.min(this.canvas.width, (clientX - rect.left) * scaleX));
      const canvasY = Math.max(0, Math.min(this.canvas.height, (clientY - rect.top) * scaleY));

      this.corners[this.activePointIndex].x = canvasX;
      this.corners[this.activePointIndex].y = canvasY;
      this.updateHomography();
    };

    const handleEnd = () => {
      if (this.activePointIndex !== -1) {
        this.save();
        this.activePointIndex = -1;
      }
    };

    // Touch events for mobile
    this.canvas.addEventListener("touchstart", (e) => {
      if (e.touches.length === 1) {
        if (handleStart(e.touches[0].clientX, e.touches[0].clientY)) {
          e.preventDefault();
        }
      }
    }, { passive: false });

    this.canvas.addEventListener("touchmove", (e) => {
      if (this.activePointIndex !== -1 && e.touches.length === 1) {
        e.preventDefault();
        handleMove(e.touches[0].clientX, e.touches[0].clientY);
      }
    }, { passive: false });

    this.canvas.addEventListener("touchend", handleEnd);
    this.canvas.addEventListener("touchcancel", handleEnd);

    // Mouse events for desktop testing
    this.canvas.addEventListener("mousedown", (e) => {
      handleStart(e.clientX, e.clientY);
    });

    window.addEventListener("mousemove", (e) => {
      handleMove(e.clientX, e.clientY);
    });

    window.addEventListener("mouseup", handleEnd);
  }

  /**
   * Renders calibration polygon, pins, and magnifying loupe onto canvas.
   */
  draw(ctx, videoElement) {
    if (this.corners.length < 4) return;

    // Draw active screen quadrilateral outline
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(this.corners[0].x, this.corners[0].y);
    for (let i = 1; i < 4; i++) {
      ctx.lineTo(this.corners[i].x, this.corners[i].y);
    }
    ctx.closePath();

    // Fill with soft cyan tint
    ctx.fillStyle = this.isEditing ? "rgba(0, 240, 255, 0.12)" : "rgba(0, 240, 255, 0.04)";
    ctx.fill();

    // Glowing border line
    ctx.lineWidth = this.isEditing ? 3.5 : 2.0;
    ctx.strokeStyle = this.isEditing ? "#00f0ff" : "rgba(0, 240, 255, 0.6)";
    ctx.shadowColor = "#00f0ff";
    ctx.shadowBlur = this.isEditing ? 12 : 6;
    ctx.stroke();
    ctx.restore();

    // If calibration mode is enabled, draw corner pins and labels
    if (this.isEditing) {
      for (let i = 0; i < 4; i++) {
        const p = this.corners[i];
        const meta = this.cornerMeta[i];
        const isActive = (i === this.activePointIndex);

        ctx.save();
        // Outer pulsing ring
        ctx.beginPath();
        ctx.arc(p.x, p.y, isActive ? 24 : 18, 0, Math.PI * 2);
        ctx.fillStyle = isActive ? meta.color : "rgba(20, 20, 30, 0.75)";
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = meta.color;
        ctx.stroke();

        // Inner solid dot
        ctx.beginPath();
        ctx.arc(p.x, p.y, isActive ? 8 : 6, 0, Math.PI * 2);
        ctx.fillStyle = isActive ? "#ffffff" : meta.color;
        ctx.fill();

        // Crosshairs
        ctx.beginPath();
        ctx.moveTo(p.x - 12, p.y);
        ctx.lineTo(p.x + 12, p.y);
        ctx.moveTo(p.x, p.y - 12);
        ctx.lineTo(p.x, p.y + 12);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = isActive ? "#ffffff" : meta.color;
        ctx.stroke();

        // Label tag
        ctx.font = "bold 13px -apple-system, sans-serif";
        ctx.fillStyle = "#ffffff";
        ctx.shadowColor = "#000000";
        ctx.shadowBlur = 4;
        const textY = i < 2 ? p.y - 26 : p.y + 36;
        ctx.textAlign = "center";
        ctx.fillText(meta.name, p.x, textY);
        ctx.restore();
      }

      // Magnifier Loupe: If a pin is actively being dragged, show zoomed loupe
      if (this.activePointIndex !== -1 && videoElement) {
        this.drawMagnifierLoupe(ctx, videoElement, this.corners[this.activePointIndex]);
      }
    }
  }

  drawMagnifierLoupe(ctx, video, targetPoint) {
    const loupeRadius = 65;
    const zoom = 2.5;

    // Position loupe in the opposite vertical half so finger does not cover it
    let loupeX = targetPoint.x;
    let loupeY = targetPoint.y - 120;
    if (loupeY - loupeRadius < 10) {
      loupeY = targetPoint.y + 120;
    }
    loupeX = Math.max(loupeRadius + 10, Math.min(this.canvas.width - loupeRadius - 10, loupeX));

    ctx.save();
    // Circular clip path for loupe
    ctx.beginPath();
    ctx.arc(loupeX, loupeY, loupeRadius, 0, Math.PI * 2);
    ctx.clip();

    // Draw magnified video area
    const sx = targetPoint.x - (loupeRadius / zoom);
    const sy = targetPoint.y - (loupeRadius / zoom);
    const sWidth = (loupeRadius * 2) / zoom;
    const sHeight = (loupeRadius * 2) / zoom;

    ctx.drawImage(
      video,
      sx, sy, sWidth, sHeight,
      loupeX - loupeRadius, loupeY - loupeRadius, loupeRadius * 2, loupeRadius * 2
    );

    // Crosshair in center of loupe
    ctx.beginPath();
    ctx.arc(loupeX, loupeY, 4, 0, Math.PI * 2);
    ctx.fillStyle = "#ff3b30";
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(loupeX - 16, loupeY);
    ctx.lineTo(loupeX + 16, loupeY);
    ctx.moveTo(loupeX, loupeY - 16);
    ctx.lineTo(loupeX, loupeY + 16);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#ff3b30";
    ctx.stroke();
    ctx.restore();

    // Loupe border
    ctx.save();
    ctx.beginPath();
    ctx.arc(loupeX, loupeY, loupeRadius, 0, Math.PI * 2);
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#ffffff";
    ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
    ctx.shadowBlur = 12;
    ctx.stroke();
    ctx.restore();
  }
}

window.CalibrationManager = CalibrationManager;
window.HomographySolver = HomographySolver;
