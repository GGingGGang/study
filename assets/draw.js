/*
 * 문서 위 펜 주석 오버레이 (Pen Annotation Overlay)
 * - 지금 보는 문서(.markdown-section) 위에 캔버스를 덮어 펜/형광펜/지우개로 필기.
 * - 문서별(현재 라우트 기준)로 localStorage('draw:<경로>')에 벡터 스트로크 저장 → 다시 방문하면 복원.
 * - PNG 내보내기(필요 시 html2canvas를 lazy-load, 실패하면 주석 레이어만 저장).
 * - 모든 동작은 try/catch로 감싸 기본 Docsify 동작을 해치지 않는다.
 */
(function () {
  'use strict';

  var PREFIX = 'draw:';
  var state = {
    active: false,
    tool: 'pen',        // pen | hl | eraser
    color: '#e23b3b',
    size: 4,
    drawing: false,
    strokes: [],        // [{tool,color,size,points:[{x,y}...]}]
    cur: null,
    key: null,
    canvas: null,
    ctx: null,
    dpr: 1
  };

  function norm(h) {
    try { h = decodeURIComponent(h); } catch (e) {}
    return h.replace(/^#/, '').replace(/^\//, '').split('?')[0].replace(/\.md$/i, '').replace(/\/$/, '');
  }
  function routeKey() { return PREFIX + (norm(location.hash) || 'home'); }

  function section() { return document.querySelector('.markdown-section'); }
  function content() { return document.querySelector('.content') || (section() && section().parentElement); }

  /* ---------- 저장/복원 ---------- */
  function load() {
    state.key = routeKey();
    state.strokes = [];
    try {
      var raw = localStorage.getItem(state.key);
      if (raw) { var arr = JSON.parse(raw); if (Array.isArray(arr)) state.strokes = arr; }
    } catch (e) {}
  }
  function save() {
    try {
      if (state.strokes.length) localStorage.setItem(state.key, JSON.stringify(state.strokes));
      else localStorage.removeItem(state.key);
    } catch (e) {}
  }

  /* ---------- 캔버스 ---------- */
  function ensureCanvas() {
    var c = content(); var sec = section();
    if (!c || !sec) return null;
    if (getComputedStyle(c).position === 'static') c.style.position = 'relative';
    if (!state.canvas || !state.canvas.isConnected) {
      var cv = document.createElement('canvas');
      cv.id = 'draw-canvas';
      c.appendChild(cv);
      state.canvas = cv;
      state.ctx = cv.getContext('2d');
      bindPointer(cv);
    }
    sizeCanvas();
    return state.canvas;
  }

  function sizeCanvas() {
    var sec = section(); var cv = state.canvas; if (!sec || !cv) return;
    var w = sec.clientWidth;
    var h = Math.max(sec.scrollHeight, sec.clientHeight);
    state.dpr = window.devicePixelRatio || 1;
    cv.style.top = sec.offsetTop + 'px';
    cv.style.left = sec.offsetLeft + 'px';
    cv.style.width = w + 'px';
    cv.style.height = h + 'px';
    cv.width = Math.round(w * state.dpr);
    cv.height = Math.round(h * state.dpr);
    state.ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    redraw();
  }

  function styleFor(ctx, s) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (s.tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
      ctx.lineWidth = s.size * 4;
    } else if (s.tool === 'hl') {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = hexToRgba(s.color, 0.32);
      ctx.lineWidth = s.size * 4;
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.size;
    }
  }

  function strokePath(ctx, s) {
    var p = s.points; if (!p || !p.length) return;
    ctx.beginPath();
    ctx.moveTo(p[0].x, p[0].y);
    if (p.length === 1) { ctx.lineTo(p[0].x + 0.1, p[0].y + 0.1); }
    else { for (var i = 1; i < p.length; i++) ctx.lineTo(p[i].x, p[i].y); }
    ctx.stroke();
  }

  function redraw() {
    var ctx = state.ctx, cv = state.canvas; if (!ctx || !cv) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.restore();
    for (var i = 0; i < state.strokes.length; i++) {
      styleFor(ctx, state.strokes[i]);
      strokePath(ctx, state.strokes[i]);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function hexToRgba(hex, a) {
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!m) return hex;
    return 'rgba(' + parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' + parseInt(m[3], 16) + ',' + a + ')';
  }

  /* ---------- 포인터 입력 ---------- */
  function toLocal(e) {
    var r = state.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function bindPointer(cv) {
    cv.addEventListener('pointerdown', function (e) {
      if (!state.active) return;
      e.preventDefault();
      try { cv.setPointerCapture(e.pointerId); } catch (x) {}
      state.drawing = true;
      state.cur = { tool: state.tool, color: state.color, size: state.size, points: [toLocal(e)] };
      styleFor(state.ctx, state.cur);
      strokePath(state.ctx, state.cur);
    });
    cv.addEventListener('pointermove', function (e) {
      if (!state.active || !state.drawing) return;
      e.preventDefault();
      state.cur.points.push(toLocal(e));
      // 마지막 두 점만 그어 점진적으로 렌더
      var p = state.cur.points, n = p.length;
      var ctx = state.ctx;
      styleFor(ctx, state.cur);
      ctx.beginPath();
      ctx.moveTo(p[n - 2].x, p[n - 2].y);
      ctx.lineTo(p[n - 1].x, p[n - 1].y);
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    });
    function end() {
      if (!state.drawing) return;
      state.drawing = false;
      if (state.cur && state.cur.points.length) { state.strokes.push(state.cur); save(); }
      state.cur = null;
    }
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointerleave', end);
    cv.addEventListener('pointercancel', end);
  }

  /* ---------- 모드/툴바 ---------- */
  function setActive(on) {
    state.active = on;
    var cv = ensureCanvas();
    if (cv) cv.classList.toggle('is-active', on);
    var tb = document.getElementById('draw-toolbar');
    if (tb) tb.classList.toggle('is-active', on);
    // 그리기 ON일 때 본문 텍스트 선택/드래그를 막는다
    try { document.body.classList.toggle('drawing-active', on); } catch (e) {}
    if (on) { load(); sizeCanvas(); }
  }

  function undo() { state.strokes.pop(); redraw(); save(); }
  function clearAll() { state.strokes = []; redraw(); save(); }

  function setOn(sel, el) {
    var nodes = document.querySelectorAll(sel);
    for (var i = 0; i < nodes.length; i++) nodes[i].classList.toggle('is-on', nodes[i] === el);
  }

  function loadHtml2canvas() {
    if (window.html2canvas) return Promise.resolve(window.html2canvas);
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
      s.onload = function () { res(window.html2canvas); };
      s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  function download(url) {
    var a = document.createElement('a');
    a.href = url;
    a.download = (norm(location.hash).split('/').pop() || 'note') + '-주석.png';
    document.body.appendChild(a); a.click(); a.remove();
  }
  function exportOverlayOnly() {
    try {
      var cv = state.canvas;
      var out = document.createElement('canvas');
      out.width = cv.width; out.height = cv.height;
      var o = out.getContext('2d');
      o.fillStyle = '#fff'; o.fillRect(0, 0, out.width, out.height);
      o.drawImage(cv, 0, 0);
      download(out.toDataURL('image/png'));
    } catch (e) {}
  }
  function exportPng() {
    var sec = section(); if (!sec) return;
    loadHtml2canvas().then(function (h2c) {
      return h2c(sec, { backgroundColor: '#ffffff', scale: 2, logging: false });
    }).then(function (base) {
      var out = document.createElement('canvas');
      out.width = base.width; out.height = base.height;
      var o = out.getContext('2d');
      o.drawImage(base, 0, 0);
      o.drawImage(state.canvas, 0, 0, base.width, base.height); // 주석 레이어 합성
      download(out.toDataURL('image/png'));
    }).catch(exportOverlayOnly);
  }

  function wireToolbar() {
    document.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('[data-draw-tool],[data-draw-color],[data-draw-size],#dt-undo,#dt-clear,#dt-png,#dt-power') : null;
      if (!t) return;
      if (t.id === 'dt-power') { setActive(!state.active); return; }
      if (t.id === 'dt-undo') { undo(); return; }
      if (t.id === 'dt-clear') { if (confirm('이 문서의 주석을 모두 지울까요?')) clearAll(); return; }
      if (t.id === 'dt-png') { exportPng(); return; }
      if (t.hasAttribute('data-draw-tool')) { state.tool = t.getAttribute('data-draw-tool'); setOn('[data-draw-tool]', t); return; }
      if (t.hasAttribute('data-draw-color')) { state.color = t.getAttribute('data-draw-color'); setOn('[data-draw-color]', t); return; }
      if (t.hasAttribute('data-draw-size')) { state.size = parseInt(t.getAttribute('data-draw-size'), 10) || 4; setOn('[data-draw-size]', t); return; }
    });
  }

  /* ---------- Docsify 연동 ---------- */
  function plugin(hook) {
    hook.doneEach(function () {
      try {
        // 라우트가 바뀌면 새 문서의 주석을 복원하고 캔버스를 다시 맞춘다
        ensureCanvas();
        load();
        sizeCanvas();
        setActive(false); // 페이지를 열 때는 항상 OFF(읽기)에서 시작
      } catch (e) {}
    });
    hook.ready(function () { wireToolbar(); });
  }

  // 콘텐츠 높이·창 크기 변화에 맞춰 캔버스 재조정
  window.addEventListener('resize', function () { try { if (state.canvas) sizeCanvas(); } catch (e) {} });
  if (window.ResizeObserver) {
    var ro = new ResizeObserver(function () { try { if (state.active && state.canvas) sizeCanvas(); } catch (e) {} });
    var startObserve = setInterval(function () {
      var sec = section();
      if (sec) { try { ro.observe(sec); } catch (e) {} clearInterval(startObserve); }
    }, 500);
  }

  window.$docsify = window.$docsify || {};
  window.$docsify.plugins = (window.$docsify.plugins || []).concat(plugin);
})();
