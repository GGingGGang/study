(function () {
  var renderer;
  window.$docsify.plugins = (window.$docsify.plugins || []).concat(function (hook) {
    hook.doneEach(async function () {
      var blocks = Array.from(document.querySelectorAll('.markdown-section pre[data-lang="mermaid"]'));
      if (!blocks.length) return;
      try {
        if (!renderer) {
          renderer = import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs').then(function (module) {
            module.default.initialize({ startOnLoad: false, securityLevel: 'strict' });
            return module.default;
          });
        }
        var mermaid = await renderer;
        var nodes = blocks.filter(function (block) { return block.isConnected; }).map(function (block) {
          var node = document.createElement('div');
          node.className = 'mermaid';
          node.textContent = block.textContent;
          block.replaceWith(node);
          return node;
        });
        if (nodes.length) await mermaid.run({ nodes: nodes });
      } catch (error) {
        console.error('Mermaid rendering failed', error);
      }
    });
  });
})();
