(function () {
  var storageKey = 'study-sidebar-open';
  var opened = new Set();
  try { opened = new Set(JSON.parse(localStorage.getItem(storageKey) || '[]')); } catch (e) {}

  function foldFolders() {
    var nav = document.querySelector('.sidebar-nav');
    if (!nav) return;

    nav.querySelectorAll('li').forEach(function (item) {
      var list = item.querySelector(':scope > ul');
      if (!list || item.querySelector(':scope > a, :scope > p > a')) return;
      var label = Array.from(item.childNodes).filter(function (node) {
        return node !== list;
      }).map(function (node) { return node.textContent; }).join('').trim();
      if (!label) return;

      var parent = item.closest('details');
      var key = (parent ? parent.dataset.folder : '') + '/' + label;
      var folder = document.createElement('details');
      var summary = document.createElement('summary');
      folder.dataset.folder = key;
      summary.textContent = label;
      folder.append(summary, list);
      folder.open = opened.has(key);
      item.replaceChildren(folder);
      folder.addEventListener('toggle', function () {
        if (folder.open) opened.add(key);
        else opened.delete(key);
        try { localStorage.setItem(storageKey, JSON.stringify(Array.from(opened))); } catch (e) {}
      });
    });

    nav.querySelectorAll('li.active, a.active').forEach(function (active) {
      for (var folder = active.closest('details'); folder; folder = folder.parentElement.closest('details')) {
        folder.open = true;
      }
    });
  }

  window.$docsify.plugins = (window.$docsify.plugins || []).concat(function (hook) {
    hook.mounted(function () {
      var nav = document.querySelector('.sidebar-nav');
      if (nav) new MutationObserver(foldFolders).observe(nav, { childList: true, subtree: true });
      foldFolders();
    });
    hook.doneEach(foldFolders);
  });
})();
