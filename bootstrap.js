/* Zotero 7–10 bootstrapped extension. No Node.js or native dependency at runtime. */
var companion;

async function startup({ id, rootURI, version }) {
  Services.scriptloader.loadSubScriptWithOptions(rootURI + "vendor/katex/katex.min.js", {
    target: globalThis, ignoreCache: true,
  });
  for (var file of ["data", "memory", "ai", "math", "markdown", "app"]) {
    Services.scriptloader.loadSubScriptWithOptions(rootURI + "modules/" + file + ".js", {
      target: globalThis, ignoreCache: true,
    });
  }
  companion = new RCApp({
    id, rootURI, version, Zotero, Services, IOUtils, PathUtils, ChromeUtils,
    Cc: Components.classes, Ci: Components.interfaces,
    fetch, setTimeout, clearTimeout,
    AbortController: Zotero.getMainWindow()?.AbortController,
  });
  await companion.start();
}

function onMainWindowLoad({ window }) { companion?.loadWindow(window); }
function onMainWindowUnload({ window }) { companion?.unloadWindow(window); }
function shutdown(_data, reason) { companion?.stop({ appShutdown: reason === APP_SHUTDOWN }); companion = null; }
function install() {}
function uninstall() {}
