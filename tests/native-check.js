(async function () {
  const out = Zotero.Prefs.get("extensions.research-companion.testOutput", true);
  const report = { version: Zotero.version, platform: Zotero.platform, checks: [], errors: [] };
  const check = (name, condition, detail = "") => { report.checks.push({ name, passed: !!condition, detail }); if (!condition) throw new Error(name + ": " + detail); };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  let testWindow;
  const testReaders = [];
  const resizeCleanup = [];
  const visible = element => {
    if (!element || !element.getClientRects().length) return false;
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const dimensions = element => {
    const rect = element.getBoundingClientRect();
    return Object.fromEntries(["top", "left", "right", "bottom", "width", "height"].map(key => [key, Math.round(rect[key] * 10) / 10]));
  };
  const captureWindow = async (win, path) => {
    // Screenshots show the resting UI rather than a persistent keyboard-focus ring.
    win.document.activeElement?.blur?.();
    const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = win.innerWidth; canvas.height = win.innerHeight;
    canvas.getContext("2d").drawWindow(win, 0, 0, win.innerWidth, win.innerHeight, "rgb(255,255,255)");
    const binary = atob(canvas.toDataURL("image/png").split(",")[1]);
    await IOUtils.write(path, Uint8Array.from(binary, character => character.charCodeAt(0)));
  };
  const capturePanel = async (win, root, path) => {
    win.document.activeElement?.blur?.();
    const rect = root.getBoundingClientRect();
    if (!root.isConnected || rect.width <= 0 || rect.height <= 0) throw new Error("The sidebar must be visible before taking its screenshot.");
    const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = Math.ceil(rect.width); canvas.height = Math.ceil(rect.height);
    // Capture only the live plugin root at its window coordinates. No PDF or
    // surrounding Zotero chrome is included, and no image processing is used.
    canvas.getContext("2d").drawWindow(win, rect.left, rect.top, rect.width, rect.height, "rgb(255,255,255)");
    const binary = atob(canvas.toDataURL("image/png").split(",")[1]);
    await IOUtils.write(path, Uint8Array.from(binary, character => character.charCodeAt(0)));
  };
  const readNetworkRequests = async () => JSON.parse(await IOUtils.readUTF8(
    PathUtils.join(PathUtils.parent(out), "network-requests.json")
  ));
  const checkReaderPaneWidths = async (win, view) => {
    const pane = win.document.getElementById("zotero-context-pane");
    const composer = view.composer || view.root.querySelector(".rc-composer");
    const advanced = view.models.closest("details");
    const previous = { width: pane.getAttribute("width"), styleWidth: pane.style.width,
      model: companion.config().model, mode: view.mode.value, draft: view.question.value,
      title: view.title.textContent, titleTooltip: view.title.title, advanced: advanced.open,
      settings: !view.settingsPage.hidden, settingsScroll: view.settingsPage.scrollTop,
      chatScroll: view.chat.scrollTop };
    const root = view.root, chat = view.chat, question = view.question;
    const viewport = { width: win.innerWidth, height: win.innerHeight };
    const longModel = "fixture-research-model-with-a-long-name-for-continuous-reader-sidebar-resizing";
    const longTitle = "因果推断与随机分组：长期追踪研究中的研究设计、机制分析和稳健性检验";
    const draft = "这段草稿尚未发送：请比较随机分组与观察性研究，并说明哪些证据可以支持因果解释。";
    const history = JSON.stringify(view.history);
    const rows = report.readerPaneWidths = [];
    // This synthetic message exists only in the DOM and is never added to the
    // conversation, sent to the API, saved to memory, or included in screenshots.
    const longFormula = Array.from({ length: 24 }, (_unused, index) => "\\frac{x_{" + index + "}^{2}}{1+y_{" + index + "}}").join(" + ");
    const columns = Array.from({ length: 12 }, (_unused, index) => "指标 " + (index + 1));
    const longMarkdown = "行内长公式：$" + longFormula + "$\n\n$$\n" + longFormula + "\n$$\n\n```js\nconst longEvidence = \""
      + "evidence_method_result_".repeat(100) + "\";\n```\n\n| " + columns.join(" | ") + " |\n| "
      + columns.map(() => "---").join(" | ") + " |\n| " + columns.map(() => "42").join(" | ") + " |";
    const wideContentFixture = win.document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    wideContentFixture.className = "rc-message"; wideContentFixture.dataset.role = "assistant";
    const fixtureProse = win.document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    fixtureProse.className = "rc-prose"; fixtureProse.append(RCMarkdown.render(win.document, longMarkdown));
    wideContentFixture.append(fixtureProse);
    const within = (element, vertical = true) => {
      const rect = element.getBoundingClientRect(), bounds = root.getBoundingClientRect();
      return visible(element) && !element.disabled && rect.left >= bounds.left - 2 && rect.right <= bounds.right + 2
        && (!vertical || (rect.top >= bounds.top - 2 && rect.bottom <= Math.min(bounds.bottom, win.innerHeight) + 2));
    };
    const overflow = elements => elements.every(element => element.scrollWidth <= element.clientWidth + 2);
    // Watch the actual production observer's teardown without changing what it
    // observes. Closing the test reader below must disconnect it and cancel rAF.
    const cleanup = { view, disconnects: 0, hasObserver: !!view.resizeObserver };
    if (view.resizeObserver) {
      const disconnect = view.resizeObserver.disconnect.bind(view.resizeObserver);
      view.resizeObserver.disconnect = () => { cleanup.disconnects++; disconnect(); };
    }
    resizeCleanup.push(cleanup);
    try {
      view.showSettings(false);
      companion.setPref("model", longModel);
      for (const current of companion.views.values()) current.syncModels();
      view.title.textContent = longTitle; view.title.title = longTitle;
      view.mode.value = "chat"; view.mode.dispatchEvent(new win.Event("change", { bubbles: true }));
      question.value = draft; question.dispatchEvent(new win.Event("input", { bubbles: true }));
      await delay(80);
      // Official Zotero 7/10 contextPane.js sets this host's style.width from
      // its width attribute in update(), also called by the reader splitter.
      // Host CSS clamps widths below 357px (inner pane min-width: 320px).
      // Keep those real constraints, never set plugin-root widths, and never
      // resize the viewport or call view.scheduleLayout() to simulate a drag.
      // Host flex shrinking can also reduce a requested 640px to under 460px
      // of actual plugin content. Larger requests exercise the real wide state.
      for (const requested of [240, 320, 480, 640, 800, 960, 320, 960, 357]) {
        chat.append(wideContentFixture);
        const firstMessage = chat.firstElementChild;
        pane.setAttribute("width", String(requested));
        win.ZoteroContextPane.update();
        await delay(220);
        const width = root.getBoundingClientRect().width;
        const expectedLayout = width < 320 ? "narrow" : width < 460 ? "normal" : "wide";
        const taskRect = dimensions(view.mode), modelRect = dimensions(view.modelSelect);
        const row = { requested, actualPane: dimensions(pane).width, actualRoot: width,
          layout: root.dataset.widthLayout, panelWidth: root.dataset.panelWidth,
          expectedLayout, viewportUnchanged: win.innerWidth === viewport.width && win.innerHeight === viewport.height,
          noOverflow: overflow([root, chat, composer]),
          controls: [question, view.mode, view.modelSelect, view.sendButton, view.settingsButton].every(element => within(element)),
          controlRows: expectedLayout === "narrow" ? modelRect.top >= taskRect.bottom - 2 : Math.abs(modelRect.top - taskRect.top) <= 2,
          statePreserved: view.root === root && view.chat === chat && view.question === question
            && Array.from(companion.views.values()).includes(view) && chat.firstElementChild === firstMessage
            && question.value === draft && JSON.stringify(view.history) === history
            && view.title.textContent === longTitle && view.modelSelect.value === longModel };
        row.longContent = [".rc-math-inline", ".rc-math-display", "pre", ".rc-md-table-wrap"].map(selector => {
          const element = wideContentFixture.querySelector(selector);
          if (!element) return { selector, missing: true, passed: false };
          const overflowX = win.getComputedStyle(element).overflowX;
          element.scrollLeft = 0; element.scrollLeft = 80;
          const metric = { selector, width: element.clientWidth, contentWidth: element.scrollWidth,
            overflowX, scrollLeft: element.scrollLeft };
          metric.passed = visible(element) && /^(auto|scroll)$/.test(overflowX)
            && metric.contentWidth > metric.width + 10 && metric.scrollLeft > 0;
          element.scrollLeft = 0; return metric;
        });
        row.longContentConfined = overflow([root, chat, composer, wideContentFixture, fixtureProse])
          && JSON.stringify(view.history) === history;
        wideContentFixture.remove();
        // Exercise the existing task change and settings/back click handlers at
        // each width. The same view and its current conversation stay mounted.
        view.mode.value = "literature-note"; view.mode.dispatchEvent(new win.Event("change", { bubbles: true }));
        row.taskChange = !view.sendButton.disabled;
        view.mode.value = "chat"; view.mode.dispatchEvent(new win.Event("change", { bubbles: true }));
        view.settingsButton.click(); await delay(40);
        advanced.open = true; view.settingsPage.scrollTop = 0;
        view.model.focus({ preventScroll: true });
        row.settings = visible(view.settingsPage) && !visible(view.chatPage)
          && win.document.activeElement === view.model && view.model.value === longModel
          && [view.baseURL, view.model, view.apiKey, view.models, view.balanceButton].every(element => within(element, false))
          && overflow([root, view.settingsPage]);
        advanced.open = previous.advanced;
        view.backButton.click(); await delay(40);
        // Enter production busy state without another HTTP request, then use
        // the real stop button to abort its controller at each sidebar width.
        const controller = new win.AbortController();
        view.controller = controller; view.startBusy();
        row.stop = within(view.cancelButton) && view.sendButton.hidden && view.modelSelect.disabled;
        view.cancelButton.click(); await delay(20);
        row.stop = row.stop && controller.signal.aborted;
        view.finish();
        row.statePreserved = row.statePreserved && visible(view.chatPage) && question.value === draft
          && JSON.stringify(view.history) === history && view.modelSelect.value === longModel && !view.sendButton.disabled;
        rows.push(row);
        if ((expectedLayout === "narrow" && requested === 240) || (expectedLayout === "wide" && rows.filter(entry => entry.layout === "wide").length === 1)) {
          chat.scrollTop = 0; question.blur(); await delay(40);
          await capturePanel(win, root, out.replace(/\.json$/, "-resizable-" + expectedLayout + "-panel.png"));
        }
      }
      const layouts = new Set(rows.map(row => row.layout));
      check("native-reader-pane-resize-layout", cleanup.hasObserver && layouts.size === 3
        && rows.every(row => row.layout === row.expectedLayout && Number(row.panelWidth) === Math.round(row.actualRoot)
          && row.viewportUnchanged && row.noOverflow && row.controls && row.controlRows)
        && Math.max(...rows.map(row => row.actualRoot)) - Math.min(...rows.map(row => row.actualRoot)) > 150, JSON.stringify(rows));
      check("native-reader-pane-resize-preserves-state", rows.every(row => row.statePreserved), JSON.stringify(rows));
      check("native-reader-pane-resize-settings-and-stop", rows.every(row => row.taskChange && row.settings && row.stop), JSON.stringify(rows));
      check("native-reader-pane-long-content-local-scroll", rows.every(row => row.longContentConfined
        && row.longContent.every(metric => metric.passed)), JSON.stringify(rows));
    } finally {
      wideContentFixture.remove();
      if (view.busy) view.finish();
      companion.setPref("model", previous.model);
      for (const current of companion.views.values()) current.syncModels();
      view.mode.value = previous.mode; view.mode.dispatchEvent(new win.Event("change", { bubbles: true }));
      question.value = previous.draft; question.dispatchEvent(new win.Event("input", { bubbles: true }));
      view.title.textContent = previous.title; view.title.title = previous.titleTooltip;
      if (previous.width === null) pane.removeAttribute("width"); else pane.setAttribute("width", previous.width);
      win.ZoteroContextPane.update(); pane.style.width = previous.styleWidth;
      advanced.open = previous.advanced; view.showSettings(previous.settings);
      await delay(220);
      view.settingsPage.scrollTop = previous.settingsScroll; chat.scrollTop = previous.chatScroll;
    }
  };
  const checkWindowsHostCSS = async (win, view) => {
    // Linux Gecko simulation of official Zotero 10.0.7 Windows host rules;
    // this is NOT a native Windows execution. Source: app/omni.ja,
    // chrome/content/zotero-platform/win/zotero.css (button/input SCSS).
    // The zero-specificity prefix limits these otherwise unchanged selectors
    // to this one plugin root, leaving Zotero's own controls untouched.
    const scope = ":where([data-rc-native-windows-fixture]) ";
    const button = ":is(button:where(:not(.btn,[type=checkbox],[type=radio])),input:where([type=button],[type=submit]))";
    const input = ":is(input:where([type=color],[type=date],[type=datetime-local],[type=email],[type=month],[type=number],[type=password],[type=search],[type=tel],[type=text],[type=time],[type=url],[type=week],[type=autocomplete],:not([type])),textbox,search-textbox,textarea):where(:not([no-native]))";
    const focusedInput = [":active", ":focus", ":focus-visible"].map(state => scope + input + ":not([disabled]):not([readonly])" + state).join(",");
    const style = win.document.createElementNS("http://www.w3.org/1999/xhtml", "style");
    style.textContent = `
      ${scope}${button}{height:28px;appearance:none;padding:0;border:1px solid rgba(0,0,0,0);border-radius:4px;background-origin:border-box;background-clip:padding-box,padding-box,border-box;background-color:unset;background-image:linear-gradient(var(--color-form-element-background), var(--color-form-element-background)),linear-gradient(var(--color-form-element-base-background), var(--color-form-element-base-background)),var(--color-form-element-border);padding:4px 11px 6px 11px}
      ${scope}${button}:not([disabled]):focus-visible{outline:var(--color-focus-outer-border) solid var(--width-focus-outer-border);outline-offset:var(--width-focus-border);box-shadow:0 0 0 var(--width-focus-border) var(--color-focus-border)}
      ${scope}${input}{appearance:none;height:26px;padding:0;padding-inline-start:5px;border:solid 1px rgba(0,0,0,0);border-radius:3px;background-origin:border-box;background-clip:padding-box;background-color:unset}
      ${scope}textarea:not([no-native]){height:unset}
      ${focusedInput}{outline:none;background-clip:border-box,padding-box;background-repeat:no-repeat}
      ${focusedInput}{border:1px solid var(--fill-quinary);border-bottom-color:var(--accent-blue);background-color:unset;background-image:linear-gradient(to top, var(--accent-blue) 2px, transparent 2px 100%),linear-gradient(rgba(255, 255, 255, 0.3), rgba(255, 255, 255, 0.3))}
    `;
    const advanced = view.models.closest("details");
    const previous = { settings: !view.settingsPage.hidden, scroll: view.settingsPage.scrollTop,
      advanced: advanced.open, active: win.document.activeElement };
    const metrics = report.windowsHostCSSSimulation = { execution: Services.appinfo.OS + " Gecko", simulatedRules: "Zotero 10.0.7 Windows; not a Windows runtime" };
    const inspect = element => {
      const computed = win.getComputedStyle(element);
      return { height: dimensions(element).height, width: dimensions(element).width,
        requiredHeight: parseFloat(computed.lineHeight) + parseFloat(computed.paddingTop) + parseFloat(computed.paddingBottom)
          + parseFloat(computed.borderTopWidth) + parseFloat(computed.borderBottomWidth),
        backgroundImage: computed.backgroundImage, boxShadow: computed.boxShadow, appearance: computed.appearance };
    };
    try {
      view.root.setAttribute("data-rc-native-windows-fixture", "");
      // Host styles precede the plugin stylesheet in real Zotero windows.
      const pluginStyle = win.document.getElementById("research-companion-style");
      if (!pluginStyle) throw new Error("Plugin stylesheet is missing before the Windows CSS simulation.");
      pluginStyle.before(style);
      view.showSettings(true); advanced.open = true; view.settingsPage.scrollTop = 0;
      view.model.focus({ preventScroll: true }); await delay(40);
      metrics.input = inspect(view.model); metrics.inputFocused = win.document.activeElement === view.model;
      view.models.focus({ preventScroll: true }); await delay(30);
      metrics.textarea = inspect(view.models); metrics.textareaFocused = win.document.activeElement === view.models;
      const settingsButton = view.settings.querySelector(".rc-row button");
      settingsButton.focus({ preventScroll: true }); await delay(30); metrics.button = inspect(settingsButton);
      view.showSettings(false); view.question.focus({ preventScroll: true }); await delay(30);
      metrics.question = inspect(view.question); metrics.questionFocused = win.document.activeElement === view.question;
      metrics.send = inspect(view.sendButton);
      view.showSettings(true); advanced.open = false; view.settingsPage.scrollTop = 0; await delay(40);
      await capturePanel(win, view.root, out.replace(/\.json$/, "-windows-css-panel.png"));
    } finally {
      style.remove(); view.root.removeAttribute("data-rc-native-windows-fixture");
      advanced.open = previous.advanced; view.showSettings(previous.settings); view.settingsPage.scrollTop = previous.scroll;
      if (previous.active?.isConnected && visible(previous.active)) previous.active.focus({ preventScroll: true });
    }
    const clean = metric => metric.backgroundImage === "none" && metric.boxShadow === "none";
    check("native-windows-host-css-simulation", metrics.inputFocused && metrics.textareaFocused && metrics.questionFocused
      && metrics.input.height > 26 && metrics.input.height >= metrics.input.requiredHeight - 2
      && metrics.button.height > 28 && metrics.button.height >= metrics.button.requiredHeight - 2
      && metrics.textarea.height >= 65 && metrics.question.height >= 36
      && metrics.send.height >= 26 && metrics.send.height <= 31 && Math.abs(metrics.send.width - metrics.send.height) <= 1
      && [metrics.input, metrics.textarea, metrics.question, metrics.button].every(clean), JSON.stringify(metrics));
  };
  try {
    await Zotero.uiReadyPromise;
    // A disposable profile installs bundled translators/styles after the UI
    // becomes ready. Await those local writes before testing or shutting down.
    // The launcher disables automaticScraperUpdates (remote translator updates).
    await Zotero.Schema.schemaUpdatePromise;
    report.localSchemaReadyAt = new Date().toISOString();
    await delay(700);
    const win = testWindow = Zotero.getMainWindow();
    win.resizeTo(1280, 1000);
    check("main-window", !!win);
    check("section-registration", !!companion.sectionID, companion.sectionID);
    check("native-network-primitives", typeof companion.ai.AbortController === "function");
    // Validate the production package via the same API used by Install From File.
    let AddonManager;
    try { ({ AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs")); }
    catch (_) { ({ AddonManager } = ChromeUtils.import("resource://gre/modules/AddonManager.jsm")); }
    const xpi = Components.classes["@mozilla.org/file/local;1"].createInstance(Components.interfaces.nsIFile);
    xpi.initWithPath(Zotero.Prefs.get("extensions.research-companion.testXPI", true));
    const candidate = await AddonManager.getInstallForFile(xpi);
    check("production-xpi-install-validation", candidate.error === 0 && !!candidate.addon, String(candidate.error));
    check("production-xpi-version-compatible", candidate.addon.isCompatible && !candidate.addon.appDisabled, candidate.addon.version);
    candidate.cancel();
    const collection = new Zotero.Collection(); collection.name = "因果推断";
    const collectionID = await collection.saveTx();
    const item = new Zotero.Item("journalArticle"); item.setField("title", "随机分组与因果推断");
    item.setField("date", "2026"); item.setField("DOI", "10.0000/fixture");
    item.setCreators([{firstName:"Test",lastName:"Researcher",creatorType:"author"}]);
    item.setCollections([collectionID]); const itemID = await item.saveTx();
    const fixture = Zotero.Prefs.get("extensions.research-companion.testPDF", true);
    const attachment = await Zotero.Attachments.importFromFile({ file: fixture, parentItemID: itemID });
    await attachment.loadAllData();
    const peer = new Zotero.Item("journalArticle"); peer.setField("title", "同组对照论文");
    peer.setCollections([collectionID]); const peerID = await peer.saveTx();
    await Zotero.Attachments.importFromFile({ file: PathUtils.join(PathUtils.parent(fixture), "supplement.pdf"), parentItemID: peerID });
    const collections = await companion.data.listCollections();
    const col = collections.find(x => x.id === collectionID);
    check("native-collections", !!col);
    const items = await companion.data.listItems(collectionID);
    check("native-collection-items", items.length === 2 && items.some(entry => entry.key === item.key));
    const files = await companion.data.attachments(item);
    check("native-attachment-path", files[0]?.exists && files[0]?.path?.endsWith("fixture.pdf"), JSON.stringify(files));
    const text = await companion.data.readText(attachment);
    check("native-pdf-extraction", text.text.includes("Sample size is 42"), JSON.stringify(text));
    await win.ZoteroPane.selectItem(itemID);
    await delay(700);
    const details = win.document.querySelector("#zotero-item-pane item-details") || win.document.querySelector("item-details");
    check("native-item-details", !!details);
    await details.scrollToPane(companion.sectionID, "instant");
    await delay(700);
    let view = Array.from(companion.views.values()).find(v => v.meta?.key === item.key && v.saved && !v.loading);
    check("native-sidebar-render", !!view, "views=" + companion.views.size);
    check("native-default-chat-page", visible(view.chatPage) && !visible(view.settingsPage));
    check("native-settings-navigation-api", typeof view.showSettings === "function");
    view.showSettings(true); await delay(50);
    check("native-settings-page", visible(view.settingsPage) && !visible(view.chatPage));
    const fixtureAPI = Zotero.Prefs.get("extensions.research-companion.testAPI", true);
    view.baseURL.value = fixtureAPI; view.model.value = "fixture-model";
    view.apiKey.value = "sk-native-fixture-only";
    await view.saveSettings();
    check("native-settings-save", companion.config().baseURL === fixtureAPI && companion.config().model === "fixture-model");
    check("native-key-store", (await companion.key(fixtureAPI)) === "sk-native-fixture-only");
    await checkWindowsHostCSS(win, view);
    view.showSettings(false); await delay(50);
    check("native-settings-return-to-chat", visible(view.chatPage) && !visible(view.settingsPage));
    const nextModel = Array.from(view.modelSelect.options).find(option => !option.disabled && option.value && option.value !== view.modelSelect.value);
    check("native-model-dropdown-options", !!nextModel, Array.from(view.modelSelect.options).map(option => option.value).join(", "));
    view.modelSelect.value = nextModel.value;
    view.modelSelect.dispatchEvent(new win.Event("change", { bubbles: true }));
    await delay(50);
    check("native-model-dropdown-persists", companion.config().model === nextModel.value && view.model.value === nextModel.value,
      JSON.stringify({ selected: view.modelSelect.value, preference: companion.config().model, settings: view.model.value }));
    view.showSettings(true); await delay(30);
    check("native-model-kept-in-settings", view.model.value === nextModel.value);
    view.showSettings(false);
    const previousComposer = { mode: view.mode.value, question: view.question.value };
    const sendAvailability = {};
    try {
      view.mode.value = "chat"; view.mode.dispatchEvent(new win.Event("change", { bubbles: true }));
      view.question.value = ""; view.question.dispatchEvent(new win.Event("input", { bubbles: true }));
      sendAvailability.emptyChatDisabled = view.sendButton.disabled;
      view.question.value = "请解释随机分组的作用。"; view.question.dispatchEvent(new win.Event("input", { bubbles: true }));
      sendAvailability.typedChatEnabled = !view.sendButton.disabled;
      view.question.value = ""; view.question.dispatchEvent(new win.Event("input", { bubbles: true }));
      sendAvailability.clearedChatDisabled = view.sendButton.disabled;
      view.mode.value = "literature-note"; view.mode.dispatchEvent(new win.Event("change", { bubbles: true }));
      sendAvailability.blankTaskEnabled = !view.sendButton.disabled;
      view.mode.value = "chat"; view.mode.dispatchEvent(new win.Event("change", { bubbles: true }));
      sendAvailability.restoredChatDisabled = view.sendButton.disabled;
      check("native-composer-send-availability", Object.values(sendAvailability).every(Boolean), JSON.stringify(sendAvailability));
    } finally {
      view.mode.value = previousComposer.mode; view.mode.dispatchEvent(new win.Event("change", { bubbles: true }));
      view.question.value = previousComposer.question; view.question.dispatchEvent(new win.Event("input", { bubbles: true }));
    }
    view.question.value = "随机分组为什么有助于因果推断？这项研究的样本量是多少？和文件夹中的其他论文对照。";
    view.question.dispatchEvent(new win.Event("input", { bubbles: true }));
    await view.send();
    check("native-chat-request-and-response", view.latest?.content.includes("42"));
    // The mock server records the actual HTTP request, which catches wiring
    // errors between the displayed choice, preferences, and API payload.
    const sentRequest = JSON.parse(await IOUtils.readUTF8(PathUtils.join(PathUtils.parent(out), "request.json")));
    const material = JSON.parse(sentRequest.messages[1].content.slice(sentRequest.messages[1].content.indexOf("{")));
    check("native-chat-fresh-collection-catalog", material.collection_items.some(entry => entry.metadata.key === peer.key));
    check("native-chat-peer-fulltext-in-request", material.related_documents.some(entry => entry.metadata.key === peer.key
      && entry.excerpts.some(excerpt => excerpt.text.includes("99") && excerpt.source_id.startsWith("R"))));
    check("native-empty-memory-and-annotations-omitted", !material.memory && !material.annotations);
    check("native-model-used-by-request", sentRequest.model === nextModel.value && sentRequest.model === view.modelSelect.value,
      JSON.stringify({ requestModel: sentRequest.model, selected: view.modelSelect.value }));
    const rendered = Array.from(view.chat.querySelectorAll(".rc-prose")).pop();
    check("native-markdown-headings-lists", !!rendered?.querySelector("h1, h2, h3") && !!rendered.querySelector("ul > li") && !!rendered.querySelector("ol > li"));
    check("native-markdown-code-table", rendered.querySelector("pre code")?.textContent.includes("sampleSize = 42")
      && rendered.querySelector("table th")?.textContent.includes("Measure")
      && Array.from(rendered.querySelectorAll("table td")).some(cell => cell.textContent === "42"));
    check("native-markdown-citation-retained", rendered.textContent.includes("F001") && rendered.textContent.includes("42"));
    const mathNamespace = "http://www.w3.org/1998/Math/MathML";
    const mathNodes = Array.from(rendered.querySelectorAll(".rc-markdown math"));
    const blockMath = mathNodes.filter(math => math.getAttribute("display") === "block");
    const inlineMath = mathNodes.filter(math => math.getAttribute("display") !== "block");
    check("native-mathml-inline-and-block", inlineMath.length >= 2 && blockMath.length >= 1
      && mathNodes.every(math => math.namespaceURI === mathNamespace && visible(math)),
      JSON.stringify(mathNodes.map(math => ({ namespace: math.namespaceURI, display: math.getAttribute("display"), size: dimensions(math) }))));
    const formulaCode = rendered.querySelector("pre code");
    check("native-mathml-structure-and-code-isolation", blockMath.some(math =>
      math.getElementsByTagNameNS(mathNamespace, "mfrac").length > 0
      && math.getElementsByTagNameNS(mathNamespace, "msup").length > 0)
      && formulaCode.textContent.includes('const literalMath = "$x^2$";') && !formulaCode.querySelector("math, .katex"));
    const scrollBeforeMathScreenshot = view.chat.scrollTop;
    try {
      view.chat.scrollTop = 0; await delay(40);
      await capturePanel(win, view.root, out.replace(/\.json$/, "-math-panel.png"));
    } catch (error) { report.mathScreenshotError = String(error); }
    finally { view.chat.scrollTop = scrollBeforeMathScreenshot; }
    // Keep adversarial fixture strings out of the human-readable conversation.
    const unsafeMarkdown = RCMarkdown.render(win.document, '<script>window.__rcUnsafeMarkdown = true;</script>\n\n<img src="data:invalid" onerror="window.__rcUnsafeMarkdown = true;">\n\n[Unsafe link](javascript:window.__rcUnsafeMarkdown=true)');
    check("native-markdown-dangerous-html-isolated", !unsafeMarkdown.querySelector("script, iframe, object, embed, img, svg, math, style, link, [onerror], [onload], [onclick]")
      && !Array.from(unsafeMarkdown.querySelectorAll("a[href]")).some(anchor => /^(?:javascript|vbscript|data):/i.test(anchor.getAttribute("href").replace(/[\u0000-\u0020]+/g, "")))
      && !win.__rcUnsafeMarkdown,
      unsafeMarkdown.innerHTML.slice(-1800));
    const historyBeforeBalance = JSON.stringify(view.history);
    const requestsBeforeBalance = await readNetworkRequests();
    view.showSettings(true); await delay(40);
    check("native-balance-ui-available", typeof view.refreshBalance === "function" && visible(view.balanceButton) && !view.balanceButton.disabled);
    await view.refreshBalance();
    check("native-balance-display", view.balanceBox.textContent.includes("CNY 110.00")
      && view.balanceBox.textContent.includes("充值") && view.balanceBox.textContent.includes("赠送"), view.balanceBox.textContent);
    const requestsAfterBalance = await readNetworkRequests();
    const balanceRequest = requestsAfterBalance[requestsAfterBalance.length - 1];
    check("native-balance-get-only-with-auth", requestsAfterBalance.length === requestsBeforeBalance.length + 1
      && balanceRequest.method === "GET" && balanceRequest.path === "/user/balance"
      && balanceRequest.bodyBytes === 0 && balanceRequest.authorizationMatchesFixture
      && requestsAfterBalance.filter(request => request.method === "POST").length === requestsBeforeBalance.filter(request => request.method === "POST").length,
      JSON.stringify(balanceRequest));
    check("native-balance-preserves-history", JSON.stringify(view.history) === historyBeforeBalance && !view.balanceButton.disabled);
    // An unsupported provider must fail before any fetch or credential transfer.
    const originalFetch = companion.ai.fetch;
    let unsupportedFetches = 0, unsupportedBalanceError;
    companion.ai.fetch = async () => { unsupportedFetches++; throw new Error("Unexpected network request to unsupported provider"); };
    try {
      await companion.ai.balance({ ...companion.config(), baseURL: "https://unsupported.example", apiKey: "sk-native-fixture-only" });
    } catch (error) { unsupportedBalanceError = error; }
    finally { companion.ai.fetch = originalFetch; }
    check("native-balance-unsupported-provider-no-network", unsupportedBalanceError?.code === "BALANCE_UNSUPPORTED" && unsupportedFetches === 0,
      JSON.stringify({ code: unsupportedBalanceError?.code, fetches: unsupportedFetches }));
    view.showSettings(false);
    const keptHistory = JSON.stringify(view.history), keptChat = view.chat.textContent;
    const unsentDraft = "尚未发送：请和下一篇文献的研究设计对比。\n保留这行补充说明。";
    view.question.value = unsentDraft;
    view.question.dispatchEvent(new win.Event("input", { bubbles: true }));
    view.showSettings(true); await delay(30);
    view.showSettings(false); await delay(30);
    check("native-navigation-preserves-draft", view.question.value === unsentDraft);
    check("native-navigation-preserves-history", JSON.stringify(view.history) === keptHistory && view.chat.textContent === keptChat);
    view.question.value = "";
    view.question.dispatchEvent(new win.Event("input", { bubbles: true }));
    view.saveType.value = "evidence-card"; view.tags.value = "method:test"; await view.saveCard();
    let saved = await companion.memory.read(col);
    check("native-card-save", saved.records.length === 1);
    check("native-card-source-sidecar", await IOUtils.exists(PathUtils.join(saved.directory, ...saved.records[0].sourcesPath.split("/"))));
    const history = await companion.memory.readConversation(col, item.key);
    check("native-conversation-save", history.length === 2);
    view.mode.value = "genealogy"; view.mode.dispatchEvent(new win.Event("change", { bubbles: true }));
    await view.send(); await view.saveMemory();
    saved = await companion.memory.read(col);
    check("native-memory-save", saved.memory.includes("42"));
    // Both exchanges above came through the mock HTTP API. Exercise each
    // completed response's own control, including the second (not oldest) turn.
    const completedReplies = Array.from(view.chat.querySelectorAll('.rc-message[data-role="assistant"]'));
    const completedQuestions = Array.from(view.chat.querySelectorAll('.rc-message[data-role="user"]'));
    const jumpButtons = completedReplies.map(reply => reply.querySelector("button.rc-jump-to-question"));
    check("native-completed-reply-jump-buttons", completedReplies.length === 2 && completedQuestions.length === 2
      && jumpButtons.every(button => visible(button) && !button.disabled && button.textContent.includes("回到本轮提问"))
      && completedQuestions.every(question => !question.querySelector("button.rc-jump-to-question")));
    const draftBeforeJump = view.question.value, scrollBeforeJump = view.chat.scrollTop;
    const historyBeforeJump = JSON.stringify(view.history), jumpDraft = "未发送草稿：请比较下一轮的研究设计。";
    const ancestors = [];
    for (let element = view.chat.parentElement; element; element = element.parentElement) ancestors.push(element);
    const outsideScroll = () => [win.scrollX, win.scrollY, ...ancestors.flatMap(element => [element.scrollLeft, element.scrollTop])];
    const jumpResults = report.jumpToQuestion = [];
    try {
      view.question.value = jumpDraft; view.question.dispatchEvent(new win.Event("input", { bubbles: true }));
      for (const index of [1, 0]) {
        const button = jumpButtons[index], question = completedQuestions[index];
        const chatRect = view.chat.getBoundingClientRect(), buttonRect = button.getBoundingClientRect();
        view.chat.scrollTop += buttonRect.bottom - chatRect.bottom + 8;
        await delay(40);
        if (index === 1) {
          // Saving memory reports its local path. Keep that private status out
          // of the public screenshot without changing the sidebar geometry.
          const statusVisibility = view.statusBox.style.visibility;
          try {
            view.statusBox.style.visibility = "hidden";
            await delay(30);
            await capturePanel(win, view.root, out.replace(/\.json$/, "-jump-panel.png"));
          }
          catch (error) { report.jumpScreenshotError = String(error); }
          finally { view.statusBox.style.visibility = statusVisibility; }
        }
        const outerBefore = outsideScroll(), before = view.chat.scrollTop;
        const controlRect = button.getBoundingClientRect(), visibleChat = view.chat.getBoundingClientRect();
        const controlInView = controlRect.top >= visibleChat.top - 2 && controlRect.bottom <= visibleChat.bottom + 2;
        button.click();
        // Support either instant scrolling or a short native smooth animation.
        let lastScroll = view.chat.scrollTop, stableFrames = 0;
        for (let attempt = 0; attempt < 30; attempt++) {
          await delay(40);
          const currentScroll = view.chat.scrollTop;
          stableFrames = Math.abs(currentScroll - lastScroll) < 0.5 ? stableFrames + 1 : 0;
          lastScroll = currentScroll;
          if (stableFrames >= 3) break;
        }
        const headOffset = question.getBoundingClientRect().top - view.chat.getBoundingClientRect().top;
        const firstHeadOffset = completedQuestions[0].getBoundingClientRect().top - view.chat.getBoundingClientRect().top;
        const result = { turn: index + 1, before, after: view.chat.scrollTop, headOffset, firstHeadOffset, controlInView,
          outerUnchanged: JSON.stringify(outsideScroll()) === JSON.stringify(outerBefore),
          draftUnchanged: view.question.value === jumpDraft, historyUnchanged: JSON.stringify(view.history) === historyBeforeJump };
        result.passed = controlInView && result.after < before - 5 && headOffset >= -3 && headOffset <= 48
          && (index === 0 || firstHeadOffset < -100) && result.outerUnchanged && result.draftUnchanged && result.historyUnchanged;
        jumpResults.push(result);
      }
      check("native-jump-to-corresponding-question", jumpResults.every(result => result.passed), JSON.stringify(jumpResults));
    } finally {
      view.question.value = draftBeforeJump; view.question.dispatchEvent(new win.Event("input", { bubbles: true }));
      view.chat.scrollTop = scrollBeforeJump;
    }
    const backupResult = await companion.memory.saveSynthesis(col, "第二版模拟分组记忆，用于验证备份。");
    check("native-memory-backup", !!backupResult.backupPath && (await IOUtils.readUTF8(backupResult.backupPath)).includes("42"));
    await view.exportInventory();
    check("native-inventory-export", await IOUtils.exists(PathUtils.join(saved.directory, "library.json")));
    const reader = await Zotero.Reader.open(attachment.id);
    testReaders.push(reader);
    await delay(1700);
    win.ZoteroContextPane.collapsed = false;
    win.document.querySelector("context-pane").mode = "item";
    win.ZoteroContextPane.update();
    await delay(400);
    const readerDetails = Array.from(win.document.querySelectorAll("item-details")).find(d => d.tabID === reader.tabID);
    check("native-reader-details", !!readerDetails);
    await readerDetails.scrollToPane(companion.sectionID, "instant"); await delay(500);
    view = Array.from(companion.views.values()).find(v => v.lastProps?.tabType === "reader" && v.attachment?.id === attachment.id && !v.loading);
    check("native-reader-current-attachment", !!view, JSON.stringify(Array.from(companion.views.values()).map(v=>({tabType:v.lastProps?.tabType,attachmentID:v.attachment?.id,loading:v.loading,status:v.statusBox.textContent}))));
    check("native-model-persisted-to-reader-view", view.modelSelect.value === companion.config().model && view.model.value === companion.config().model);
    let popup;
    companion.selectionHandler({reader, doc:win.document, params:{annotation:{text:"Sample size is 42.",pageLabel:"1"}}, append:b=>{popup=b;}});
    popup.click();
    check("native-reader-selection-handler", view.selectionBox.textContent.includes("42") && view.selectionBox.textContent.includes("1"));
    const alternate = await Zotero.Attachments.importFromFile({ file: fixture.replace(/fixture\.pdf$/, "supplement.pdf"), parentItemID: itemID });
    const secondReader = await Zotero.Reader.open(alternate.id);
    testReaders.push(secondReader);
    await delay(1200);
    const secondDetails = Array.from(win.document.querySelectorAll("item-details")).find(d => d.tabID === secondReader.tabID);
    await secondDetails.scrollToPane(companion.sectionID, "instant"); await delay(400);
    const secondView = Array.from(companion.views.values()).find(v => v.lastProps?.tabType === "reader" && v.attachment?.id === alternate.id && !v.loading);
    check("native-supplement-exact-binding", !!secondView && secondView.meta.key === item.key);
    check("native-supplement-text", (await companion.data.readText(secondView.attachment)).text.includes("99"));
    check("native-selection-isolation", !secondView.selectionBox.textContent.includes("Sample size is 42"));
    win.Zotero_Tabs.select(reader.tabID); await delay(300);
    await readerDetails.scrollToPane(companion.sectionID, "instant");
    view.showSettings(false);
    await readerDetails.scrollToPane(companion.sectionID, "instant"); await delay(200);
    const originalHistory = view.history;
    try {
      view.history = Array.from({ length: 24 }, (_unused, index) => ({ role: index % 2 ? "assistant" : "user", content: "阅读对话 " + index + "：样本量为 **42**。[F001]\n\n这段内容用于验证较长的对话能在聊天区域内滚动，同时保留底部输入框。" }));
      view.renderHistory(); await delay(60);
      const chatStyle = win.getComputedStyle(view.chat);
      view.chat.scrollTop = 0; view.chat.scrollTop = view.chat.scrollHeight; await delay(30);
      check("native-chat-internal-scroll", /^(auto|scroll)$/.test(chatStyle.overflowY)
        && view.chat.clientHeight > 100 && view.chat.scrollHeight > view.chat.clientHeight
        && view.chat.scrollTop > 0,
        JSON.stringify({ overflowY: chatStyle.overflowY, height: view.chat.clientHeight, contentHeight: view.chat.scrollHeight, scrollTop: view.chat.scrollTop }));
    } finally { view.history = originalHistory; view.renderHistory(); }
    await delay(100);
    const composer = view.composer || view.root.querySelector(".rc-composer");
    check("native-composer-present", visible(composer));
    const geometry = report.chatLayout = {
      viewport: { width: win.innerWidth, height: win.innerHeight },
      root: dimensions(view.root), chat: dimensions(view.chat), composer: dimensions(composer),
      question: dimensions(view.question), model: dimensions(view.modelSelect), send: dimensions(view.sendButton)
    };
    check("native-bottom-composer-layout", geometry.chat.height > 100
      && geometry.composer.top >= geometry.chat.bottom - 3
      && geometry.question.top >= geometry.composer.top - 3
      && geometry.question.bottom <= geometry.composer.bottom + 3
      && geometry.model.top >= geometry.composer.top - 3
      && geometry.model.bottom <= geometry.composer.bottom + 3
      && geometry.send.top >= geometry.composer.top - 3
      && geometry.send.bottom <= geometry.composer.bottom + 3,
      JSON.stringify(geometry));
    check("native-bottom-controls-within-window", geometry.model.left >= 0 && geometry.model.right <= win.innerWidth + 3
      && geometry.send.left >= 0 && geometry.send.right <= win.innerWidth + 3
      && geometry.composer.bottom <= win.innerHeight + 3, JSON.stringify(geometry));
    check("native-default-compact-sidebar-width", geometry.composer.width >= 260 && geometry.composer.width <= 300,
      "Default composer width=" + geometry.composer.width + "px (target approximately 288px)");
    check("native-default-no-horizontal-overflow", [view.root, view.chat, composer].every(element => element.scrollWidth <= element.clientWidth + 2),
      JSON.stringify([view.root, view.chat, composer].map(element => ({ className: element.className, width: element.clientWidth, contentWidth: element.scrollWidth }))));
    await checkReaderPaneWidths(win, view);
    view.showSettings(true); view.settingsPage.scrollTop = 0;
    await view.refreshBalance(); await delay(100);
    check("native-reader-settings-balance", view.balanceBox.textContent.includes("CNY 110.00"));
    check("native-settings-screenshot-without-key", visible(view.settingsPage) && view.apiKey.value === "");
    try {
      await captureWindow(win, out.replace(/\.json$/, "-settings.png"));
      await capturePanel(win, view.root, out.replace(/\.json$/, "-settings-panel.png"));
    }
    catch (error) { report.settingsScreenshotError = String(error); }
    view.showSettings(false); await delay(100);
    check("native-screenshot-default-chat-page", visible(view.chatPage) && !visible(view.settingsPage));
    // Keep the answer heading visible in the screenshot; the scrolling check
    // above already verified that the bottom of a long conversation is reachable.
    view.chat.scrollTop = 0;
    report.directory = saved.directory;
    report.viewText = view.root.textContent;
    try {
      await captureWindow(win, out.replace(/\.json$/, ".png"));
      await capturePanel(win, view.root, out.replace(/\.json$/, "-panel.png"));
    }
    catch (error) { report.screenshotError = String(error); }

    const stateBeforeEmpty = { history: view.history, pendingQuestion: view.pendingQuestion, question: view.question.value, mode: view.mode.value,
      selection: companion.selections.get(view.attachment.id) };
    try {
      view.history = []; view.pendingQuestion = null; view.question.value = "";
      view.mode.value = "chat"; view.mode.dispatchEvent(new win.Event("change", { bubbles: true }));
      view.question.dispatchEvent(new win.Event("input", { bubbles: true }));
      companion.selections.delete(view.attachment.id); view.updateSelection(); view.renderHistory();
      view.question.blur(); await delay(80);
      check("native-empty-chat-state", visible(view.chatPage) && !!view.chat.querySelector(".rc-empty") && view.chat.querySelectorAll(".rc-message").length === 0);
      await captureWindow(win, out.replace(/\.json$/, "-empty.png"));
      await capturePanel(win, view.root, out.replace(/\.json$/, "-empty-panel.png"));
    } finally {
      view.history = stateBeforeEmpty.history; view.pendingQuestion = stateBeforeEmpty.pendingQuestion; view.question.value = stateBeforeEmpty.question;
      view.mode.value = stateBeforeEmpty.mode; view.mode.dispatchEvent(new win.Event("change", { bubbles: true }));
      view.question.dispatchEvent(new win.Event("input", { bubbles: true }));
      if (stateBeforeEmpty.selection) companion.selections.set(view.attachment.id, stateBeforeEmpty.selection);
      view.updateSelection(); view.renderHistory(); view.chat.scrollTop = 0;
    }

    // Resize only this disposable Zotero test window. Keep the native default
    // sidebar width so its roughly 288px content column is exercised again.
    win.resizeTo(900, 760); await delay(300); win.ZoteroContextPane.update();
    await readerDetails.scrollToPane(companion.sectionID, "instant");
    view.scheduleLayout?.(); await delay(150);
    const narrow = report.narrowChatLayout = {
      viewport: { width: win.innerWidth, height: win.innerHeight }, root: dimensions(view.root),
      composer: dimensions(composer), model: dimensions(view.modelSelect), send: dimensions(view.sendButton)
    };
    check("native-narrow-window-bottom-controls", win.innerWidth <= 960
      && narrow.composer.bottom <= win.innerHeight + 3 && narrow.composer.top >= 0
      && [narrow.model, narrow.send].every(rect => rect.width > 0 && rect.height > 0
        && rect.left >= narrow.root.left - 2 && rect.right <= narrow.root.right + 2
        && rect.bottom <= win.innerHeight + 3), JSON.stringify(narrow));
    check("native-narrow-no-horizontal-overflow", [view.root, view.chat, composer].every(element => element.scrollWidth <= element.clientWidth + 2),
      JSON.stringify([view.root, view.chat, composer].map(element => ({ className: element.className, width: element.clientWidth, contentWidth: element.scrollWidth }))));
    view.chat.scrollTop = 0; view.question.blur();
    try { await captureWindow(win, out.replace(/\.json$/, "-narrow.png")); }
    catch (error) { report.narrowScreenshotError = String(error); }
    win.resizeTo(1280, 1000); await delay(250); win.ZoteroContextPane.update();
    await readerDetails.scrollToPane(companion.sectionID, "instant"); view.scheduleLayout?.(); await delay(100);

    // This is Zotero's own Light/Dark preference, changed only in the fresh
    // profile created by native-smoke.py and restored immediately afterwards.
    const themePref = "browser.theme.toolbar-theme", originalTheme = Services.prefs.getIntPref(themePref);
    try {
      Services.prefs.setIntPref(themePref, 0); await delay(350);
      report.darkModeMatched = win.matchMedia("(prefers-color-scheme: dark)").matches;
      if (report.darkModeMatched) {
        view.chat.scrollTop = 0; view.question.blur();
        await captureWindow(win, out.replace(/\.json$/, "-dark.png"));
        await capturePanel(win, view.root, out.replace(/\.json$/, "-dark-panel.png"));
      } else { report.darkScreenshotError = "The isolated profile did not apply the dark color-scheme dynamically."; }
    } catch (error) { report.darkScreenshotError = String(error); }
    finally { Services.prefs.setIntPref(themePref, originalTheme); }
  } catch (error) { report.errors.push(String(error) + "\n" + (error.stack || "")); }
  finally {
    // Close only readers created by this isolated test, including after a
    // failed assertion, and allow their state/save notifications to complete.
    for (const reader of testReaders.reverse()) {
      try {
        if (reader?.tabID && testWindow?.Zotero_Tabs) await testWindow.Zotero_Tabs.close(reader.tabID);
      } catch (error) { report.errors.push("Reader cleanup: " + error); }
    }
    try {
      await delay(500);
      await Zotero.DB.waitForTransaction();
      companion.stop(); check("native-shutdown", companion.views.size === 0 && !companion.active);
      if (resizeCleanup.length) {
        for (const entry of resizeCleanup) entry.view.scheduleLayout?.();
        check("native-resize-observer-cleanup", resizeCleanup.every(entry => entry.hasObserver && entry.disconnects > 0
          && entry.view.destroyed && !entry.view.root.isConnected && entry.view.layoutFrame == null),
        JSON.stringify(resizeCleanup.map(entry => ({ hasObserver: entry.hasObserver, disconnects: entry.disconnects,
          destroyed: entry.view.destroyed, connected: entry.view.root.isConnected, pendingFrame: entry.view.layoutFrame }))));
      }
    } catch (error) { report.errors.push("Shutdown preparation: " + error); }
    report.complete = true;
    report.finishedAt = new Date().toISOString();
    await IOUtils.writeUTF8(out, JSON.stringify(report,null,2));
    Services.startup.quit(Components.interfaces.nsIAppStartup.eForceQuit);
  }
})();
