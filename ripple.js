(() => {
  const canvas = document.getElementById('globalRipple');
  const ctx = canvas.getContext('2d');
  const SCALE = 3, DAMP = 0.978; // faster fade — ~2-3s instead of ~6s
  let w, h, buf0, buf1, buf2, imgData;

  function resize() {
    w = Math.ceil(window.innerWidth / SCALE);
    h = Math.ceil(window.innerHeight / SCALE);
    canvas.width = w; canvas.height = h;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    buf0 = new Float32Array(w * h);
    buf1 = new Float32Array(w * h);
    buf2 = new Float32Array(w * h);
    imgData = ctx.createImageData(w, h);
  }
  resize();
  window.addEventListener('resize', resize);

  // ── Cursor dot (own lightweight canvas, merged into main RAF) ──
  const dotCanvas = document.createElement('canvas');
  dotCanvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:10000;';
  document.body.appendChild(dotCanvas);
  const dctx = dotCanvas.getContext('2d');
  let dotDpr = 1;
  function resizeDot() {
    dotDpr = Math.min(devicePixelRatio, 2);
    dotCanvas.width = window.innerWidth * dotDpr;
    dotCanvas.height = window.innerHeight * dotDpr;
    dotCanvas.style.width = window.innerWidth + 'px';
    dotCanvas.style.height = window.innerHeight + 'px';
    dctx.setTransform(dotDpr, 0, 0, dotDpr, 0, 0);
  }
  resizeDot();
  window.addEventListener('resize', resizeDot);

  let dotX = -99, dotY = -99;
  window.addEventListener('mousemove', e => { dotX = e.clientX; dotY = e.clientY; }, { passive: true });

  function drawDot(t) {
    dctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    if (dotX > 0) {
      const pulse = 1 + Math.sin(t * 0.003) * 0.06;
      dctx.globalAlpha = 0.03; dctx.fillStyle = '#0000DD';
      dctx.beginPath(); dctx.arc(dotX, dotY, 22 * pulse, 0, Math.PI * 2); dctx.fill();
      dctx.globalAlpha = 0.18; dctx.fillStyle = '#4466FF';
      dctx.beginPath(); dctx.arc(dotX, dotY, 2.5 * pulse, 0, Math.PI * 2); dctx.fill();
      dctx.globalAlpha = 0.5; dctx.fillStyle = '#aabbff';
      dctx.beginPath(); dctx.arc(dotX, dotY, 1, 0, Math.PI * 2); dctx.fill();
      dctx.globalAlpha = 1;
    }
  }

  // ── Drop / echo ──
  function drop(cx, cy, strength, radius) {
    const gx = (cx / SCALE) | 0, gy = (cy / SCALE) | 0;
    const r = Math.ceil(radius / SCALE);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const px = gx + dx, py = gy + dy;
      if (px < 1 || px >= w - 1 || py < 1 || py >= h - 1) continue;
      const d = Math.sqrt(dx * dx + dy * dy) / r;
      if (d > 1) continue;
      buf0[py * w + px] += strength * (1 - d * d);
    }
  }

  const echoes = [];
  function dropWithEcho(cx, cy, strength, radius, echoCount, echoDelay) {
    drop(cx, cy, strength, radius);
    for (let i = 1; i <= echoCount; i++) {
      echoes.push({ x: cx, y: cy, strength: strength * Math.pow(0.4, i), radius: radius + i * 6, time: performance.now() + echoDelay * i });
    }
  }

  function processEchoes() {
    const now = performance.now();
    for (let i = echoes.length - 1; i >= 0; i--) {
      if (now >= echoes[i].time) {
        drop(echoes[i].x, echoes[i].y, echoes[i].strength, echoes[i].radius);
        echoes.splice(i, 1);
      }
    }
  }

  // Drop radius scales with viewport so ripples stay proportional at any width
  function moveR() { return Math.round(Math.max(10, window.innerWidth * 0.017)); }
  function clickR() { return Math.round(Math.max(16, window.innerWidth * 0.027)); }

  // ── Mouse input ──
  let lastX = -1, lastY = -1, lastMouseTime = 0;
  window.addEventListener('mousemove', e => {
    const cx = e.clientX, cy = e.clientY;
    lastMouseTime = performance.now();
    sleeping = false;
    if (lastX < 0) { lastX = cx; lastY = cy; }
    const dx = cx - lastX, dy = cy - lastY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const steps = Math.max(1, Math.ceil(dist / 12));
    for (let s = 0; s <= steps; s++) {
      const f = s / steps;
      dropWithEcho(lastX + dx * f, lastY + dy * f, 30, moveR(), 1, 180);
    }
    lastX = cx; lastY = cy;
  }, { passive: true });

  window.addEventListener('click', e => {
    lastMouseTime = performance.now();
    sleeping = false;
    dropWithEcho(e.clientX, e.clientY, 80, clickR(), 3, 250);
  });

  // ── Sleep mode ──
  // When ripples die down AND mouse has been idle for 1.5s, stop simulating.
  // Wake immediately on any mouse activity.
  let sleeping = false;
  let quietFrames = 0;
  const QUIET_THRESHOLD = 0.15;
  const SLEEP_AFTER_FRAMES = 45; // ~1.5s at 30fps

  // ── 30fps cap for simulation ──
  const SIM_MS = 1000 / 30;
  let lastSimTime = 0;

  let hidden = false;
  document.addEventListener('visibilitychange', () => {
    hidden = document.hidden;
    if (!hidden) { sleeping = false; requestAnimationFrame(frame); }
  });

  function frame(t) {
    if (hidden) return;
    requestAnimationFrame(frame);

    // Cursor dot: draw while mouse is active, clear once when it goes idle
    if (t - lastMouseTime < 2000) {
      drawDot(t);
    } else {
      dctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    }

    // Ripple simulation capped at 30fps
    const elapsed = t - lastSimTime;
    if (elapsed < SIM_MS) return;
    lastSimTime = t - (elapsed % SIM_MS);

    // If sleeping, skip all simulation/rendering
    if (sleeping) return;

    processEchoes();

    // Simulate — track max amplitude to detect quiet state
    let maxAmp = 0;
    for (let y = 1; y < h - 1; y++) {
      const row = y * w;
      for (let x = 1; x < w - 1; x++) {
        const i = row + x;
        const v = ((buf1[i-1] + buf1[i+1] + buf1[i-w] + buf1[i+w]) * 0.5 - buf0[i]) * DAMP;
        buf2[i] = v;
        const a = v < 0 ? -v : v;
        if (a > maxAmp) maxAmp = a;
      }
    }
    const tmp = buf0; buf0 = buf1; buf1 = buf2; buf2 = tmp;

    // Check if we should sleep
    const idleMs = t - lastMouseTime;
    if (maxAmp < QUIET_THRESHOLD && idleMs > 1500 && echoes.length === 0) {
      quietFrames++;
      if (quietFrames >= SLEEP_AFTER_FRAMES) {
        sleeping = true;
        ctx.clearRect(0, 0, w, h);
        return;
      }
    } else {
      quietFrames = 0;
    }

    // Render pixels
    const data = imgData.data;
    for (let i = 0, len = w * h; i < len; i++) {
      const pi = i << 2, val = buf1[i], abs = val < 0 ? -val : val;
      if (abs < 0.25) { data[pi] = 0; data[pi+1] = 0; data[pi+2] = 0; data[pi+3] = 0; continue; }
      const t2 = Math.min(abs * 0.018, 1); const sq = t2 * t2;
      if (val > 0) {
        data[pi]   = (sq * 10)       | 0;
        data[pi+1] = (sq * 30)       | 0;
        data[pi+2] = (30 + sq * 180) | 0;
        data[pi+3] = (15 + sq * 140) | 0;
      } else {
        data[pi]   = 0;
        data[pi+1] = (sq * 10)       | 0;
        data[pi+2] = (15 + sq * 120) | 0;
        data[pi+3] = (10 + sq * 110) | 0;
      }
    }
    ctx.putImageData(imgData, 0, 0);
  }

  requestAnimationFrame(frame);

  // ── Reveal on scroll ──
  const obs = new IntersectionObserver(entries => {
    entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('visible'); });
  }, { threshold: 0.08, rootMargin: '0px 0px -30px 0px' });
  document.querySelectorAll('.reveal').forEach(el => obs.observe(el));
})();
