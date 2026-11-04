/* Runs only in the independent upgrade-test helper's bootstrap scope. */
(async function () {
  "use strict";
  const configPath = Zotero.Prefs.get("extensions.research-companion-upgrade-test.config", true);
  const config = JSON.parse(await IOUtils.readUTF8(configPath));
  const report = {
    schemaVersion: 1, zoteroVersion: Zotero.version, platform: Services.appinfo.OS,
    from: config.from, to: config.to, helperID: config.helperID,
    startedAt: new Date().toISOString(), checks: [], errors: [], installEvents: [], complete: false,
    scope: "One isolated profile, one Zotero process, no real API calls or credentials",
    mode: config.startupOnly ? "startup-only-control" : "hot-upgrade",
  };
  const path = name => PathUtils.join(config.workDirectory, name);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const save = () => IOUtils.writeUTF8(config.reportPath, JSON.stringify(report, null, 2));
  const check = (name, condition, detail = "") => report.checks.push({ name, passed: !!condition, detail });
  const need = (name, condition, detail = "") => {
    check(name, condition, detail);
    if (!condition) throw new Error(name + ": " + detail);
  };
  const waitFor = async (predicate, description, timeout = 15000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const value = await predicate();
      if (value) return value;
      await delay(100);
    }
    throw new Error("Timed out waiting for " + description);
  };
  const dimensions = element => {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return Object.fromEntries(["top", "left", "right", "bottom", "width", "height"]
      .map(key => [key, Math.round(rect[key] * 100) / 100]));
  };
  const visible = element => {
    if (!element?.isConnected) return false;
    const rect = element.getBoundingClientRect();
    const css = element.ownerDocument.defaultView.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && css.display !== "none" && css.visibility !== "hidden";
  };
  const styles = (win, element) => {
    if (!element) return null;
    const css = win.getComputedStyle(element);
    return Object.fromEntries(["display", "position", "borderRadius", "borderTopWidth", "borderTopColor",
      "backgroundColor", "color", "fontSize", "padding", "overflowY", "height", "width", "gridTemplateColumns"]
      .map(key => [key, css[key]]));
  };
  const versionText = root => Array.from(root.querySelectorAll(".rc-muted")).map(element => element.textContent)
    .find(text => /^(?:Research Companion|LitThread) /.test(text)) || "";
  const matchesVersion = (text, version) => text === "Research Companion " + version || text === "LitThread " + version;
  const snapshot = win => ({
    at: new Date().toISOString(), viewport: { width: win.innerWidth, height: win.innerHeight },
    stylesheets: Array.from(win.document.querySelectorAll('link[id="research-companion-style"]')).map(link => {
      let rules;
      try { rules = Array.from(link.sheet?.cssRules || []).map(rule => rule.cssText); }
      catch (error) { rules = [String(error)]; }
      return { href: link.href, disabled: link.sheet?.disabled, rules };
    }),
    menus: Array.from(win.document.querySelectorAll('[id="research-companion-menu"]')).map(menu => menu.outerHTML),
    sections: Array.from(win.document.querySelectorAll("item-pane-custom-section"))
      .filter(section => String(section.dataset.pane).includes("research-companion"))
      .map(section => ({ paneID: section.dataset.pane, tabID: section.closest("item-details")?.tabID,
        rootCount: section.querySelectorAll(".rc-root").length })),
    roots: Array.from(win.document.querySelectorAll(".rc-root")).map(root => ({
      tabID: root.closest("item-details")?.tabID, visible: visible(root), html: root.outerHTML,
      oldBrandText: root.querySelector(".rc-brand")?.textContent || "",
      versionLabel: root.querySelector(".rc-version")?.textContent || "",
      versionText: versionText(root),
      model: root.querySelector(".rc-model-select")?.value, dimensions: dimensions(root),
      compact: root.dataset.compact,
      computed: Object.fromEntries([".rc-composer", ".rc-composer-controls", ".rc-chat", ".rc-context-chip",
        ".rc-toolbar", '[aria-label="发送问题"]', '.rc-message[data-role="user"]', '.rc-message[data-role="assistant"]']
        .map(selector => [selector, styles(win, root.querySelector(selector))])),
    })),
  });
  const capture = async (win, file, root) => {
    win.document.activeElement?.blur?.();
    const rect = root ? root.getBoundingClientRect() : { left: 0, top: 0, width: win.innerWidth, height: win.innerHeight };
    if (rect.width <= 0 || rect.height <= 0) throw new Error("Cannot screenshot invisible root");
    const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = Math.ceil(rect.width); canvas.height = Math.ceil(rect.height);
    canvas.getContext("2d").drawWindow(win, rect.left, rect.top, rect.width, rect.height, "rgb(255,255,255)");
    const binary = atob(canvas.toDataURL("image/png").split(",")[1]);
    await IOUtils.write(file, Uint8Array.from(binary, character => character.charCodeAt(0)));
  };
  const sectionID = () => Zotero.ItemPaneManager.customSectionData.options
    .find(section => section.pluginID === config.from.id || section.header?.l10nID === "research-companion-section")?.paneID;
  let win, AddonManager, beforeRoots = [], beforeSections = [], beforeRoot, reader, item, collection, memoryPath, memorySentinel, conversationPath, conversationSentinel;
  const prefs = {};
  try {
    await Zotero.uiReadyPromise;
    win = await waitFor(() => Zotero.getMainWindow(), "main window");
    await waitFor(() => win.ZoteroPane?.itemsView && win.ZoteroPane?.collectionsView?.itemTreeView, "initialized library views");
    // First-run bundled translators/styles install after uiReadyPromise. A fast
    // upgrade test must await it, or shutdown can race translatorCache writes.
    // The launcher disables automaticScraperUpdates, so this is local setup.
    await Zotero.Schema.schemaUpdatePromise;
    report.localSchemaReadyAt = new Date().toISOString();
    win.resizeTo(1280, 1000);
    try { ({ AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs")); }
    catch (_) { ({ AddonManager } = ChromeUtils.import("resource://gre/modules/AddonManager.jsm")); }
    const oldAddon = await waitFor(async () => {
      const addon = await AddonManager.getAddonByID(config.from.id);
      return addon?.isActive && sectionID() && addon;
    }, "active original plugin");
    need("old-production-addon-active", oldAddon.version === config.from.version, oldAddon.version);
    need("independent-helper-active", config.helperID !== config.from.id && (await AddonManager.getAddonByID(config.helperID))?.isActive);
    report.helperContinuationToken = String(Date.now()) + "-" + Math.random();
    const helperToken = report.helperContinuationToken;
    collection = new Zotero.Collection(); collection.name = "热升级隔离测试";
    const collectionID = await collection.saveTx();
    item = new Zotero.Item("journalArticle"); item.setField("title", "热升级合成论文：随机分组与因果推断");
    item.setField("date", "2026"); item.setCollections([collectionID]);
    const itemID = await item.saveTx();
    const attachment = await Zotero.Attachments.importFromFile({ file: config.fixturePDF, parentItemID: itemID });
    const memoryRoot = path("sentinel-memory");
    Object.assign(prefs, {
      "extensions.research-companion.baseURL": "https://upgrade-fixture.invalid",
      "extensions.research-companion.model": "upgrade-sentinel-model",
      "extensions.research-companion.models": "upgrade-sentinel-model\nupgrade-alternative-model",
      ["extensions.research-companion.folder." + collection.libraryID + "." + collection.key]: memoryRoot,
    });
    for (const [key, value] of Object.entries(prefs)) Zotero.Prefs.set(key, value, true);
    const memoryDirectory = PathUtils.join(memoryRoot, "library-" + collection.libraryID, "collection-" + collection.key);
    await IOUtils.makeDirectory(PathUtils.join(memoryDirectory, "conversations"), { createAncestors: true });
    memoryPath = PathUtils.join(memoryDirectory, "memory.md");
    memorySentinel = "# 热升级测试记忆\n\n独立 helper 写入的合成 sentinel；升级必须逐字保留。\n";
    await IOUtils.writeUTF8(memoryPath, memorySentinel);
    conversationPath = PathUtils.join(memoryDirectory, "conversations", "item-" + item.key + ".json");
    conversationSentinel = JSON.stringify({ schemaVersion: 1, itemKey: item.key, messages: [
      { role: "user", content: "随机分组如何帮助理解因果推断？" },
      { role: "assistant", content: "## 从研究设计开始\n\n这是一段**热升级测试**的合成对话。随机分组减少选择偏差，但仍需核对样本与研究设计。[F001]\n\n- 保留同一文献上下文\n- 升级后继续阅读\n\n> 未请求任何真实 AI 服务。" },
    ] }, null, 2);
    await IOUtils.writeUTF8(conversationPath, conversationSentinel);
    await win.ZoteroPane.selectItem(itemID);
    const libraryDetails = await waitFor(() => win.document.querySelector("#zotero-item-pane item-details") || win.document.querySelector("item-details"), "library item pane");
    await libraryDetails.scrollToPane(sectionID(), "instant");
    await waitFor(() => libraryDetails.querySelector(".rc-root .rc-message"), "old library sidebar conversation");
    reader = await Zotero.Reader.open(attachment.id);
    await delay(1200);
    win.ZoteroContextPane.collapsed = false;
    win.document.querySelector("context-pane").mode = "item";
    win.ZoteroContextPane.update();
    const readerDetails = await waitFor(() => Array.from(win.document.querySelectorAll("item-details")).find(details => details.tabID === reader.tabID), "reader details");
    await readerDetails.scrollToPane(sectionID(), "instant");
    beforeRoot = await waitFor(() => {
      const root = readerDetails.querySelector(".rc-root");
      return visible(root) && root.querySelector(".rc-message") && root;
    }, "old reader sidebar conversation");
    await delay(350);
    beforeRoots = Array.from(win.document.querySelectorAll(".rc-root"));
    beforeSections = beforeRoots.map(root => root.closest("item-pane-custom-section"));
    report.before = snapshot(win);
    need("old-dom-version", report.before.roots.every(root => matchesVersion(root.versionText, config.from.version)), report.before.roots.map(root => root.versionText));
    need("old-two-view-contexts", beforeRoots.length >= 2, beforeRoots.length);
    need("old-single-stylesheet-menu", report.before.stylesheets.length === 1 && report.before.menus.length === 1);
    need("old-single-root-per-view", report.before.sections.length >= 2 && report.before.sections.every(section => section.rootCount === 1), report.before.sections);
    await IOUtils.writeUTF8(path("before-dom-css.json"), JSON.stringify(report.before, null, 2));
    await capture(win, path("before.png")); await capture(win, path("before-panel.png"), beforeRoot);
    await save();
    if (config.startupOnly) return;
    const file = Components.classes["@mozilla.org/file/local;1"].createInstance(Components.interfaces.nsIFile);
    file.initWithPath(config.toXPI);
    const install = await AddonManager.getInstallForFile(file);
    need("replacement-package-compatible", install.error === 0 && install.addon?.isCompatible && !install.addon?.appDisabled, { error: install.error, version: install.addon?.version });
    need("replacement-manifest-version", install.addon.version === config.to.version, install.addon.version);
    report.installStartedAt = new Date().toISOString();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { install.removeListener(listener); reject(new Error("AddonManager installation timed out")); }, 30000);
      const finish = error => { clearTimeout(timer); install.removeListener(listener); error ? reject(error) : resolve(); };
      const record = (event, entry) => report.installEvents.push({ event, at: new Date().toISOString(), state: entry.state, error: entry.error });
      const listener = {
        onInstallStarted(entry) { record("onInstallStarted", entry); },
        onInstallEnded(entry, addon) { record("onInstallEnded", entry); report.installedVersion = addon.version; finish(); },
        onInstallFailed(entry) { record("onInstallFailed", entry); finish(new Error("Install failed: " + entry.error)); },
        onDownloadFailed(entry) { record("onDownloadFailed", entry); finish(new Error("Download failed: " + entry.error)); },
        onInstallCancelled(entry) { record("onInstallCancelled", entry); finish(new Error("Install cancelled")); },
      };
      install.addListener(listener);
      Promise.resolve(install.install()).catch(finish);
    });
    check("addon-manager-real-replacement", report.installedVersion === config.to.version && report.installEvents.some(event => event.event === "onInstallEnded"), report.installEvents);
    try {
      await waitFor(() => {
        const root = readerDetails.querySelector(".rc-root");
        return root && root !== beforeRoot && matchesVersion(versionText(root), config.to.version);
      }, "replacement DOM without restart", 20000);
    } catch (error) { report.errors.push(String(error)); }
    await delay(500);
    if (sectionID()) await readerDetails.scrollToPane(sectionID(), "instant");
    await delay(400);
    const installed = await AddonManager.getAddonByID(config.to.id);
    check("new-addon-manager-version-active", installed.version === config.to.version && installed.isActive && !installed.appDisabled,
      { version: installed.version, active: installed.isActive, pendingOperations: installed.pendingOperations });
    check("helper-survived-same-process", report.helperContinuationToken === helperToken && win === Zotero.getMainWindow()
      && (await AddonManager.getAddonByID(config.helperID))?.isActive);
    report.after = snapshot(win);
    report.stylesheetRulesUnchanged = JSON.stringify(report.before.stylesheets.map(sheet => sheet.rules))
      === JSON.stringify(report.after.stylesheets.map(sheet => sheet.rules));
    await IOUtils.writeUTF8(path("after-dom-css.json"), JSON.stringify(report.after, null, 2));
    await capture(win, path("after.png"));
    const afterRoot = readerDetails.querySelector(".rc-root");
    if (visible(afterRoot)) await capture(win, path("after-panel.png"), afterRoot);
    check("old-dom-fully-detached", beforeRoots.every(root => !root.isConnected), beforeRoots.map(root => root.isConnected));
    check("old-sections-fully-detached", beforeSections.every(section => section && !section.isConnected), beforeSections.map(section => section?.isConnected));
    check("replacement-sections-have-new-identities", Array.from(win.document.querySelectorAll(".rc-root"))
      .every(root => !beforeSections.includes(root.closest("item-pane-custom-section"))));
    check("no-old-brand-text-remains", report.after.roots.every(root => !root.oldBrandText), report.after.roots.map(root => root.oldBrandText));
    check("new-dom-version-every-view", report.after.roots.length >= 2 && report.after.roots.every(root => matchesVersion(root.versionText, config.to.version)), report.after.roots.map(root => root.versionText));
    check("new-single-stylesheet", report.after.stylesheets.length === 1, report.after.stylesheets.map(sheet => sheet.href));
    check("new-single-menu", report.after.menus.length === 1, report.after.menus.length);
    check("new-single-root-per-view", report.after.sections.length >= 2 && report.after.sections.every(section => section.rootCount === 1), report.after.sections);
    const shown = report.after.roots.find(root => root.visible);
    check("new-reader-sidebar-visible", !!shown, report.after.roots.map(root => ({ tabID: root.tabID, visible: root.visible })));
    check("new-composer-rounded-18px", shown?.computed[".rc-composer"]?.borderRadius === "18px", shown?.computed[".rc-composer"]);
    check("new-composer-grid-controls", shown?.computed[".rc-composer-controls"]?.display === "grid", shown?.computed[".rc-composer-controls"]);
    check("new-article-context-chip", shown?.computed[".rc-context-chip"]?.display === "flex", shown?.computed[".rc-context-chip"]);
    check("new-assistant-borderless", shown?.computed['.rc-message[data-role="assistant"]']?.borderTopWidth === "0px", shown?.computed['.rc-message[data-role="assistant"]']);
    check("new-send-circular", shown?.computed['[aria-label="发送问题"]']?.borderRadius === "50%", shown?.computed['[aria-label="发送问题"]']);
    check("configuration-sentinel-preserved", Object.entries(prefs).every(([key, value]) => Zotero.Prefs.get(key, true) === value));
    check("model-in-every-view-preserved", report.after.roots.length >= 2 && report.after.roots.every(root => root.model === prefs["extensions.research-companion.model"]), report.after.roots.map(root => root.model));
    check("memory-sentinel-byte-preserved", await IOUtils.readUTF8(memoryPath) === memorySentinel);
    check("conversation-byte-preserved", await IOUtils.readUTF8(conversationPath) === conversationSentinel);
    check("conversation-rendered-after-upgrade", !!afterRoot?.querySelector('.rc-message[data-role="assistant"]')?.textContent.includes("热升级测试"));
    if (afterRoot) {
      afterRoot.querySelector('[aria-label="打开设置"]')?.click(); await delay(150);
      check("settings-shows-target-version", afterRoot.querySelector(".rc-version")?.textContent === "v" + config.to.version, afterRoot.querySelector(".rc-version")?.textContent);
      await capture(win, path("after-settings.png"));
      if (visible(afterRoot)) await capture(win, path("after-settings-panel.png"), afterRoot);
    }
  } catch (error) {
    report.errors.push(String(error) + "\n" + (error.stack || ""));
    if (win) {
      try {
        report.failureSnapshot = snapshot(win);
        await IOUtils.writeUTF8(path("failure-dom-css.json"), JSON.stringify(report.failureSnapshot, null, 2));
        await capture(win, path("failure.png"));
      } catch (captureError) { report.errors.push("Failure capture: " + captureError); }
    }
  } finally {
    // Let reader/save transactions settle before asking the isolated app to
    // quit; quitting while a reader is still persisting state can hang shutdown.
    try {
      if (reader && win?.Zotero_Tabs) await win.Zotero_Tabs.close(reader.tabID);
      await delay(500);
      await Zotero.DB.waitForTransaction();
    } catch (error) { report.cleanupWarning = String(error); }
    report.complete = true;
    report.finishedAt = new Date().toISOString();
    await save();
    Services.startup.quit(Components.interfaces.nsIAppStartup.eForceQuit);
  }
})();
