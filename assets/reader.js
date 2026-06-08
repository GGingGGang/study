/*
 * 무한 스크롤 읽기 (Infinite Scroll Reader)
 * - _sidebar.md를 파싱해 "그룹(같은 묶음)" 단위 문서 순서를 만든다(사이드바 DOM에 의존하지 않음).
 * - 아래로 스크롤해 현재 문서 끝에 닿으면 다음 문서를 이어 붙인다. 그룹 끝까지 계속(무한 스크롤).
 * - 현재 문서를 연 직후 '다음 문서'를 미리 한 편 붙여 자연스럽게 이어지게 한다.
 * - 보고 있는 위치에 맞춰 사이드바 활성표시·URL(해시)·우하단 배지(현재/전체)를 갱신한다.
 * - 켜고 끄기: localStorage('reader-continuous') === 'off' 이면 비활성(기본 ON).
 * - 디버그 로그: localStorage.setItem('reader-debug','1') 후 콘솔 확인.
 * - 모든 동작은 try/catch로 감싸 실패해도 기본 Docsify 동작을 해치지 않는다.
 */
(function () {
  'use strict';

  var KEY = 'reader-continuous';
  function enabled() { try { return localStorage.getItem(KEY) !== 'off'; } catch (e) { return true; } }
  function dbg() {
    try { if (localStorage.getItem('reader-debug') === '1') console.log.apply(console, ['[reader]'].concat([].slice.call(arguments))); } catch (e) {}
  }

  // 파일 경로 정규화(앞 슬래시·.md·URL 인코딩 제거) -> 비교용 키
  function normFile(f) {
    if (!f) return '';
    try { f = decodeURIComponent(f); } catch (e) {}
    return f.replace(/^\//, '').replace(/\.md$/i, '').replace(/\/$/, '');
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }
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

  // _sidebar.md 파싱: 최상위 '- ...'마다 새 그룹, 들여쓴 '- [제목](경로.md)'는 그 그룹의 멤버
  function parseSidebar(text) {
    var lines = text.split(/\r?\n/), groups = [], cur = null;
    var linkRe = /\[([^\]]*)\]\(([^)]+)\)/;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^-\s+/.test(line)) {                 // 최상위 항목 -> 새 그룹 시작
        cur = []; groups.push(cur);
        var m = linkRe.exec(line);
        if (m && /\.md$/i.test(m[2])) cur.push(mkItem(m));
      } else if (/^\s+-\s+/.test(line)) {       // 들여쓴 항목 -> 현재 그룹 멤버
        var m2 = linkRe.exec(line);
        if (m2 && cur && /\.md$/i.test(m2[2])) cur.push(mkItem(m2));
      }
    }
    return groups;
  }
  function mkItem(m) {
    var file = m[2].replace(/^\//, '').split('?')[0];
    return { title: (m[1] || '').trim(), file: file, href: '#/' + file.replace(/\.md$/i, '') };
  }

  function plugin(hook, vm) {
    var S = { seq: [], idx: -1, busy: false, loading: {}, bound: false, token: 0 };
    var groupsPromise = null;

    function section() { return document.querySelector('.markdown-section'); }

    function getGroups() {
      if (groupsPromise) return groupsPromise;
      groupsPromise = fetch('_sidebar.md', { headers: { 'cache-control': 'no-cache' } })
        .then(function (r) { if (!r.ok) throw new Error('sidebar ' + r.status); return r.text(); })
        .then(parseSidebar)
        .catch(function (e) { dbg('sidebar fetch 실패', e); groupsPromise = null; return []; });
      return groupsPromise;
    }

    function currentFile() {
      var f = (vm && vm.route && vm.route.file) ? vm.route.file : '';
      if (!f) { // 폴백: 해시에서 추출
        try { f = decodeURIComponent(location.hash).replace(/^#\//, '').split('?')[0]; } catch (e) {}
        if (f && !/\.md$/i.test(f)) f += '.md';
      }
      return normFile(f);
    }

    function findGroup(groups, fileKey) {
      for (var g = 0; g < groups.length; g++) {
        for (var i = 0; i < groups[g].length; i++) {
          if (normFile(groups[g][i].file) === fileKey) return { seq: groups[g], idx: i };
        }
      }
      return null;
    }

    function compile(md) {
      try { if (vm && vm.compiler && vm.compiler.compile) return vm.compiler.compile(md); } catch (e) { dbg('compile 실패', e); }
      try { if (window.marked) return window.marked.parse ? window.marked.parse(md) : window.marked(md); } catch (e) {}
      return '<p>(문서를 변환하지 못했습니다)</p>';
    }

    function fetchMd(file) {
      return fetch(file, { headers: { 'cache-control': 'no-cache' } }).then(function (r) {
        if (!r.ok) throw new Error('http ' + r.status);
        return r.text();
      });
    }

    function makePanel(item) {
      var panel = document.createElement('div');
      panel.className = 'doc-panel';
      panel.setAttribute('data-seq', String(item.seqIndex));
      panel.setAttribute('data-href', item.href);
      panel.innerHTML = '<div class="doc-divider"><span>▾ ' + esc(item.title) + '</span></div>' + compile(item.md);
      renderMath(panel);
      return panel;
    }

    function appendIndex(i) {
      if (i < 0 || i >= S.seq.length || S.busy || S.loading[i]) return;
      var sec = section(); if (!sec || sec.querySelector('.doc-panel[data-seq="' + i + '"]')) return;
      S.busy = true; S.loading[i] = true;
      var myToken = S.token;
      var item = S.seq[i]; item.seqIndex = i;
      dbg('append', i, item.file);
      fetchMd(item.file).then(function (md) {
        if (myToken !== S.token) return;       // 그새 라우트가 바뀌면 중단
        var s = section(); if (!s) return;
        item.md = md;
        s.appendChild(makePanel(item));
        updatePos();
      }).catch(function (e) { dbg('append 실패', i, e); }).then(function () {
        S.busy = false; S.loading[i] = false;
        if (myToken === S.token) setTimeout(function () { try { fill(); } catch (e) {} }, 0);
      });
    }

    // 마지막 패널이 화면 근처면 다음 문서를 불러온다
    function fill() {
      if (!S.seq.length || S.busy) return;
      var sec = section(); if (!sec) return;
      var panels = sec.querySelectorAll('.doc-panel');
      if (!panels.length) return;
      var last = panels[panels.length - 1];
      var lastIdx = parseInt(last.getAttribute('data-seq'), 10);
      if (lastIdx < S.seq.length - 1 && last.getBoundingClientRect().bottom < window.innerHeight + 1200) {
        appendIndex(lastIdx + 1);
      }
    }

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

    function sidebarLinkFor(href) {
      var nav = document.querySelector('.sidebar-nav'); if (!nav) return null;
      var as = nav.querySelectorAll('a'); var key = normFile(href.replace(/^#\//, ''));
      for (var i = 0; i < as.length; i++) {
        if (normFile((as[i].getAttribute('href') || '').replace(/^#\//, '')) === key) return as[i];
      }
      return null;
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
          var aA = nav.querySelectorAll('a.active'); for (var q = 0; q < aA.length; q++) aA[q].classList.remove('active');
          var lA = nav.querySelectorAll('li.active'); for (var w = 0; w < lA.length; w++) lA[w].classList.remove('active');
          var el = sidebarLinkFor(S.seq[i].href);
          if (el) { el.classList.add('active'); var li = el.closest('li'); if (li) li.classList.add('active'); }
        }
      } catch (e) {}
      try { history.replaceState(null, '', S.seq[i].href); } catch (e) {}
      updatePos();
    }

    function onScroll() {
      fill();
      var f = focusIndex();
      if (f !== S.idx) setFocus(f);
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
      S.token++; S.seq = []; S.idx = -1; S.loading = {}; S.busy = false;
      var bar = document.getElementById('reader-pos'); if (bar) bar.style.display = 'none';
    }

    hook.doneEach(function () {
      reset();
      if (!enabled()) { dbg('비활성(OFF)'); return; }
      var fileKey = currentFile();
      var myToken = S.token;
      dbg('doneEach file=', fileKey);
      getGroups().then(function (groups) {
        if (myToken !== S.token) return;            // 그새 라우트 변경됨
        var found = findGroup(groups, fileKey);
        if (!found) { dbg('그룹 못 찾음', fileKey); return; }
        if (found.seq.length <= 1) { dbg('그룹 문서 1개뿐'); return; }
        S.seq = found.seq; S.idx = found.idx;
        dbg('그룹 적용: idx', found.idx, '/ total', found.seq.length);
        var sec = section(); if (!sec) return;
        // 현재 문서를 패널로 감싼다(분리선 없음)
        var focus = document.createElement('div');
        focus.className = 'doc-panel doc-panel--focus';
        focus.setAttribute('data-seq', String(found.idx));
        focus.setAttribute('data-href', S.seq[found.idx].href);
        while (sec.firstChild) focus.appendChild(sec.firstChild);
        sec.appendChild(focus);
        bind();
        updatePos();
        appendIndex(found.idx + 1);   // 다음 문서를 바로 이어 붙임
      });
    });
  }

  // Docsify 로드 전에 플러그인 등록
  window.$docsify = window.$docsify || {};
  window.$docsify.plugins = (window.$docsify.plugins || []).concat(plugin);
})();
