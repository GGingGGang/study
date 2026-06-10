/*
 * 앵커 스크롤 보강 (Anchor Scroll Fix)
 * - 사이드바의 하위 헤딩 링크(#/path?id=heading)를 눌렀을 때 해당 헤딩으로 확실히 스크롤한다.
 * - Docsify 기본 동작이 커스텀(고정 토글·auto2top·캔버스 오버레이 등)과 얽혀 빗나가는 경우를 보강.
 * - getElementById 기반이라 한글/숫자로 시작하는 id에도 안전. getBoundingClientRect로 위치 계산해
 *   offsetParent(.content position) 변화에 영향받지 않는다.
 */
(function () {
  'use strict';

  var OFFSET = 14; // 상단 여백(고정 토글 등 고려)

  function idFromHash() {
    var h = location.hash || '';
    var m = /[?&]id=([^&]+)/.exec(h);
    return m ? m[1] : '';
  }

  function findEl(raw) {
    if (!raw) return null;
    var dec = raw;
    try { dec = decodeURIComponent(raw); } catch (e) {}
    return document.getElementById(dec) || document.getElementById(raw) || null;
  }

  // 본문(콘텐츠)을 최상단으로. 사이드바(.sidebar)는 건드리지 않는다.
  function contentToTop() {
    try { window.scrollTo(0, 0); } catch (e) {}
    try { if (document.scrollingElement) document.scrollingElement.scrollTop = 0; } catch (e) {}
    try { document.documentElement.scrollTop = 0; document.body.scrollTop = 0; } catch (e) {}
    ['.content', '.markdown-section'].forEach(function (sel) {
      var el = document.querySelector(sel);
      if (el) { try { el.scrollTop = 0; } catch (e) {} }
    });
  }

  function scrollToId() {
    var raw = idFromHash();
    if (!raw) { contentToTop(); return; }   // 헤딩 지정 없음 → 본문 최상단
    var el = findEl(raw);
    if (!el) { contentToTop(); return; }     // id 못 찾음 → 본문 최상단
    var y = el.getBoundingClientRect().top + window.pageYOffset - OFFSET;
    window.scrollTo(0, y);
  }

  // 라우트 렌더 후/해시 변경 후, 레이아웃·수식 렌더가 끝나며 위치가 바뀔 수 있어 여러 번 시도
  function scrollSoon() {
    if (idFromHash()) {
      // 특정 헤딩으로 이동: 렌더 후 위치 보정 위해 여러 번
      [0, 60, 200].forEach(function (t) { setTimeout(scrollToId, t); });
    } else {
      // 문서 전환: 본문 무조건 맨 위로
      setTimeout(contentToTop, 0);
      setTimeout(contentToTop, 50);
    }
  }

  window.addEventListener('hashchange', scrollSoon);

  window.$docsify = window.$docsify || {};
  window.$docsify.plugins = (window.$docsify.plugins || []).concat(function (hook) {
    hook.doneEach(function () { scrollSoon(); });
  });
})();
