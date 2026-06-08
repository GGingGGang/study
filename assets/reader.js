/*
 * 연속 읽기 (Continuous Reader)
 * - 사이드바 그룹(같은 <ul>) 안에서 현재 문서 앞뒤 문서를 이어 붙여
 *   최대 3문서(이전·현재·다음) 슬라이딩 윈도로 보여준다.
 * - 스크롤로 다음 문서가 이어지고, 두 칸 위 문서는 떨어져 나간다.
 *   현재 보고 있는 문서에 맞춰 사이드바 활성표시와 URL(해시)도 갱신한다.
 * - 켜고 끄기: localStorage('reader-continuous') === 'off' 이면 비활성(기본 ON).
 * - 모든 동작은 try/catch로 감싸 실패해도 기본 Docsify 동작을 해치지 않는다.
 */
(function () {
  'use strict';

  var KEY = 'reader-continuous';
  function enabled() { try { return localStorage.getItem(KEY) !== 'off'; } catch (e) { return true; } }

  // 해시/href를 비교용 경로로 정규화: '#/notes/a.md?id=x' -> 'notes/a'
  function norm(h) {
    try { h = decodeURIComponent(h); } catch (e) {}
    return h.replace(/^#/, '').replace(/^\//, '').split('?')[0].replace(/\.md$/i, '').replace(/\/$/, '');
  }
  // 사이드바 href -> fetch용 파일 경로: '#/notes/a' -> 'notes/a.md'
  function hrefToFile(href) {
    var p = href.replace(/^#\//, '').split('?')[0];
    if (!/\.md$/i.test(p)) p += '.md';
    return p;
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }

  // 동적으로 붙인 문서의 수식($...$, $$...$$)을 KaTeX로 렌더
  function renderMath(el) {
    if (typeof window.renderMathInElement === 'function') {
      try {
        window.renderMathInElement(el, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false },
            { left: '\\(', right: '\\)', display: false },
            { left: '\\[', right: '\\]', display: true }
          ],
          throwOnError: false
        });
      } catch (e) {}
    }
  }

  function plugin(hook, vm) {
    var S = { seq: [], idx: -1, busy: false, loading: {}, bound: false };

    function section() { return document.querySelector('.markdown-section'); }

    // 현재 문서가 속한 사이드바 그룹(<ul>)의 링크들을 순서대로 수집
    function buildSeq() {
      var nav = document.querySelector('.sidebar-nav');
      if (!nav) return null;
      var cur = norm(location.hash);
      var active = nav.querySelector('a.active');
      if (!active) {
        var all = nav.querySelectorAll('a');
        for (var i = 0; i < all.length; i++) {
          if (norm(all[i].getAttribute('href') || '') === cur) { active = all[i]; break; }
        }
      }
      if (!active) return null;
      var ul = active.closest('ul');
      if (!ul) return null;
      var links = ul.querySelectorAll(':scope > li > a');
      var seq = [];
      for (var j = 0; j < links.length; j++) {
        var a = links[j];
        var href = a.getAttribute('href') || '';
        if (!/^#\//.test(href)) continue; // 외부/홈 링크 제외
        seq.push({ href: href, file: hrefToFile(href), title: (a.textContent || '').trim(), el: a });
      }
      var idx = -1;
      for (var k = 0; k < seq.length; k++) { if (norm(seq[k].href) === cur) { idx = k; break; } }
      if (idx < 0) return null;
      return { seq: seq, idx: idx };
    }

    function fetchMd(file) {
      return fetch(file, { headers: { 'cache-control': 'no-cache' } }).then(function (r) {
        if (!r.ok) throw new Error('http ' + r.status);
        return r.text();
      });
    }

    function makePanel(item, md) {
      var panel = document.createElement('div');
      panel.className = 'doc-panel';
      panel.setAttribute('data-seq', String(item.seqIndex));
      panel.setAttribute('data-href', item.href);
      var html = '';
      try { html = vm.compiler.compile(md); } catch (e) { html = '<p>(문서를 변환하지 못했습니다)</p>'; }
      panel.innerHTML = '<div class="doc-divider"><span>▾ ' + esc(item.title) + '</span></div>' + html;
      renderMath(panel);
      return panel;
    }

    function appendIndex(i) {
      if (i < 0 || i >= S.seq.length || S.busy || S.loading[i]) return;
      var sec = section(); if (!sec || sec.querySelector('.doc-panel[data-seq="' + i + '"]')) return;
      S.busy = true; S.loading[i] = true;
      var item = S.seq[i]; item.seqIndex = i;
      fetchMd(item.file).then(function (md) {
        var s = section(); if (!s) return;
        s.appendChild(makePanel(item, md));
        updatePos();
      }).catch(function () {}).then(function () { S.busy = false; S.loading[i] = false; });
    }

    function prependIndex(i) {
      if (i < 0 || i >= S.seq.length || S.busy || S.loading[i]) return;
      var sec = section(); if (!sec || sec.querySelector('.doc-panel[data-seq="' + i + '"]')) return;
      S.busy = true; S.loading[i] = true;
      var item = S.seq[i]; item.seqIndex = i;
      fetchMd(item.file).then(function (md) {
        var s = section(); if (!s) return;
        var panel = makePanel(item, md);
        s.insertBefore(panel, s.querySelector('.doc-panel'));
        // 위에 문서가 추가됐으니 스크롤 위치를 그만큼 내려 화면이 튀지 않게 보정
        window.scrollBy(0, panel.offsetHeight);
        updatePos();
      }).catch(function () {}).then(function () { S.busy = false; S.loading[i] = false; });
    }

    // 화면 상단 1/3 지점에 걸린 패널을 '현재 문서'로 본다
    function focusIndex() {
      var sec = section(); if (!sec) return S.idx;
      var panels = sec.querySelectorAll('.doc-panel');
      var line = window.innerHeight * 0.33;
      var chosen = panels[0];
      for (var i = 0; i < panels.length; i++) {
        if (panels[i].getBoundingClientRect().top <= line) chosen = panels[i]; else break;
      }
      return chosen ? parseInt(chosen.getAttribute('data-seq'), 10) : S.idx;
    }

    function setFocus(i) {
      if (i === S.idx || i < 0 || i >= S.seq.length) return;
      S.idx = i;
      var sec = section();
      var panels = sec.querySelectorAll('.doc-panel');
      for (var p = 0; p < panels.length; p++) {
        panels[p].classList.toggle('doc-panel--focus', parseInt(panels[p].getAttribute('data-seq'), 10) === i);
      }
      try {
        var nav = document.querySelector('.sidebar-nav');
        if (nav) {
          var as = nav.querySelectorAll('a.active'); for (var q = 0; q < as.length; q++) as[q].classList.remove('active');
          var lis = nav.querySelectorAll('li.active'); for (var w = 0; w < lis.length; w++) lis[w].classList.remove('active');
          var el = S.seq[i].el;
          if (el) { el.classList.add('active'); var li = el.closest('li'); if (li) li.classList.add('active'); }
        }
      } catch (e) {}
      try { history.replaceState(null, '', S.seq[i].href); } catch (e) {} // 라우팅 없이 URL만 갱신
      updatePos();
    }

    // 현재 문서 기준 [이전·현재·다음]만 남기고 나머지는 제거 (윈도 크기 3)
    function prune(f) {
      var sec = section(); if (!sec) return;
      var panels = Array.prototype.slice.call(sec.querySelectorAll('.doc-panel'));
      for (var i = 0; i < panels.length; i++) {
        var si = parseInt(panels[i].getAttribute('data-seq'), 10);
        if (si < f - 1) { var h = panels[i].offsetHeight; panels[i].remove(); window.scrollBy(0, -h); }
        else if (si > f + 1) { panels[i].remove(); }
      }
    }

    function onScroll() {
      if (!S.seq.length) return;
      var sec = section(); if (!sec) return;
      var panels = sec.querySelectorAll('.doc-panel');
      if (!panels.length) return;
      var last = panels[panels.length - 1];
      var lastIdx = parseInt(last.getAttribute('data-seq'), 10);
      if (lastIdx < S.seq.length - 1 && last.getBoundingClientRect().bottom < window.innerHeight + 900) appendIndex(lastIdx + 1);
      var first = panels[0];
      var firstIdx = parseInt(first.getAttribute('data-seq'), 10);
      if (firstIdx > 0 && first.getBoundingClientRect().top > -900) prependIndex(firstIdx - 1);
      var f = focusIndex();
      if (f !== S.idx) { setFocus(f); prune(f); }
    }

    function updatePos() {
      var bar = document.getElementById('reader-pos');
      if (!bar) { bar = document.createElement('div'); bar.id = 'reader-pos'; document.body.appendChild(bar); }
      if (!S.seq.length) { bar.style.display = 'none'; return; }
      bar.style.display = 'block';
      bar.textContent = (S.idx + 1) + ' / ' + S.seq.length;
    }

    function bind() {
      if (S.bound) return; S.bound = true;
      var ticking = false;
      window.addEventListener('scroll', function () {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(function () { ticking = false; try { onScroll(); } catch (e) {} });
      }, { passive: true });
    }

    function reset() {
      S.seq = []; S.idx = -1; S.loading = {};
      var bar = document.getElementById('reader-pos'); if (bar) bar.style.display = 'none';
    }

    hook.doneEach(function () {
      reset();
      if (!enabled()) return;
      try {
        var built = buildSeq();
        if (!built || built.seq.length <= 1) return; // 그룹에 문서가 하나뿐이면 그대로
        S.seq = built.seq; S.idx = built.idx;
        var sec = section(); if (!sec) return;
        // 현재 문서를 패널로 감싼다(분리선 없음)
        var focus = document.createElement('div');
        focus.className = 'doc-panel doc-panel--focus';
        focus.setAttribute('data-seq', String(built.idx));
        focus.setAttribute('data-href', S.seq[built.idx].href);
        while (sec.firstChild) focus.appendChild(sec.firstChild);
        sec.appendChild(focus);
        appendIndex(built.idx + 1); // 다음 문서 미리 이어 붙임
        bind();
        updatePos();
      } catch (e) {}
    });
  }

  // Docsify 로드 전에 플러그인 등록
  window.$docsify = window.$docsify || {};
  window.$docsify.plugins = (window.$docsify.plugins || []).concat(plugin);
})();
