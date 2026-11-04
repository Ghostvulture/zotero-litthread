(function (root) {
  "use strict";
  const NS = "http://www.w3.org/1999/xhtml";
  const PREF = "extensions.research-companion.";
  const MODES = {
    chat: "段落问答", "literature-note": "文献笔记", "claim-card": "观点卡片",
    "evidence-card": "论证素材", genealogy: "分组知识脉络",
  };
  const QUESTIONS = {
    "literature-note": "为当前文献生成结构化阅读笔记：问题、理论、方法、发现、局限、与其他工作的关系。区分原文证据与推断。",
    "claim-card": "从选中段落（没有则从正文）提炼一张观点卡片，只写一个可复用的观点，给出原文依据、适用边界、主题/理论/方法标签。",
    "evidence-card": "从选中段落（没有则从正文）提炼一张论证素材卡，记录研究设计、样本、量表/指标、结果或机制、支持什么观点、局限和来源。不可虚构数字。",
    genealogy: "结合分组文献目录、已保存卡片和已有记忆，梳理领域问题、奠基工作、核心争议、范式演进、研究缺口与学习路线。明确区分已经提供的证据和待核实关系，不能从标题推断实际引用或被引。",
  };

  class RCApp {
    constructor(env) {
      Object.assign(this, env);
      this.data = new root.RCData(env);
      this.memory = new root.RCMemory(env);
      this.ai = new root.RCAI(env);
      this.views = new Map();
      this.selections = new Map();
      this.sessionKeys = new Map();
      this.credentialVersion = 0;
      this.windows = new Set();
      this.active = false;
    }
    pref(key, fallback = "") { return this.Zotero.Prefs.get(PREF + key, true) ?? fallback; }
    setPref(key, value) { this.Zotero.Prefs.set(PREF + key, value, true); }
    config() { return { baseURL: this.pref("baseURL", "https://api.deepseek.com"), model: this.pref("model", "deepseek-flash") }; }
    modelChoices() {
      return [...new Set([this.config().model, ...String(this.pref("models", "deepseek-flash\ndeepseek-v4-pro")).split(/[,，\n]/)]
        .map(value => value.trim()).filter(value => value && value.length <= 128))].slice(0, 50);
    }
    rootFor(collection) { return this.pref("folder." + collection.libraryID + "." + collection.key); }
    async key(baseURL) {
      if (this.sessionKeys.has(baseURL)) return this.sessionKeys.get(baseURL);
      try {
        return this.Services.logins.findLogins("chrome://research-companion", null, baseURL)[0]?.password || "";
      } catch (_) { return ""; }
    }
    async storeKey(baseURL, value) {
      this.credentialVersion++;
      for (const view of this.views.values()) view.resetBalance();
      this.sessionKeys.set(baseURL, value);
      try {
        const old = this.Services.logins.findLogins("chrome://research-companion", null, baseURL);
        if (value) {
          const login = this.Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(this.Ci.nsILoginInfo);
          login.init("chrome://research-companion", null, baseURL, "api-key", value, "", "");
          if (old.length) this.Services.logins.modifyLogin(old[0], login);
          else await this.Services.logins.addLoginAsync(login);
          for (const entry of old.slice(1)) this.Services.logins.removeLogin(entry);
        } else {
          for (const entry of old) this.Services.logins.removeLogin(entry);
        }
        return "API Key 已保存在 Zotero 登录管理器中。";
      } catch (_) {
        if (!value) throw new Error("已停用本次会话的 Key，但无法访问登录管理器删除持久凭据。请稍后重试清除。");
        return "登录管理器不可用：Key 仅在本次 Zotero 会话有效，重启后需重新输入。";
      }
    }
    async start() {
      this.active = true;
      for (const win of this.Zotero.getMainWindows()) this.loadWindow(win);
      this.sectionID = this.Zotero.ItemPaneManager.registerSection({
        paneID: "research-companion", pluginID: this.id,
        header: { l10nID: "research-companion-section", l10nArgs: "{}", icon: this.rootURI + "icons/companion.svg" },
        sidenav: { l10nID: "research-companion-section", l10nArgs: "{}", icon: this.rootURI + "icons/companion.svg" },
        onInit: ({ doc }) => { if (this.active) this.loadWindow(doc.defaultView); },
        onItemChange: ({ body, item, setEnabled }) => {
          if (!this.active) return;
          setEnabled(!!item && !item.isNote?.() && !item.isAnnotation?.());
          const view = this.views.get(body);
          if (view && view.hookItemID !== item?.id) view.invalidate();
        },
        onRender: props => {
          if (!this.active) return;
          if (!this.views.has(props.body)) this.views.set(props.body, new View(this, props));
        },
        onAsyncRender: props => this.active && this.views.get(props.body)?.bind(props).catch(e => this.views.get(props.body)?.error(e)),
        onDestroy: ({ body }) => { this.views.get(body)?.destroy(); this.views.delete(body); },
      });
      if (!this.sectionID) throw new Error("LitThread: 无法注册 Zotero 右侧栏。");
      this.selectionHandler = event => {
        if (!this.active) return;
        const { reader, doc, params, append } = event;
        const text = params.annotation?.text;
        if (!text) return;
        const button = doc.createElement("button");
        button.textContent = "问研脉";
        button.title = "把选中段落加入右侧研脉助手；此操作不会发送 API 请求";
        button.addEventListener("click", () => {
          this.selections.set(reader.itemID, { text, pageLabel: params.annotation?.pageLabel || "" });
          let matched = false;
          for (const view of this.views.values()) {
            if (view.attachment?.id === reader.itemID) {
              matched = true;
              view.updateSelection();
              view.body.closest("item-details")?.scrollToPane?.(this.sectionID);
              view.question.focus({ preventScroll: true });
            }
          }
          button.textContent = matched ? "已加入右侧助手" : "已记住选文，请在主窗口标签页打开本文";
        });
        append(button);
      };
      this.Zotero.Reader.registerEventListener("renderTextSelectionPopup", this.selectionHandler, this.id);
    }
    loadWindow(win) {
      if (!win?.document) return;
      // A new URI prevents a document from reusing a previous release's CSS.
      // Reconcile orphan links as well as windows opened after an upgrade.
      const href = this.rootURI + "style.css?v=" + encodeURIComponent(this.version);
      const existing = Array.from(win.document.querySelectorAll('[id="research-companion-style"]'));
      if (existing.length !== 1 || existing[0].getAttribute("href") !== href) {
        for (const element of existing) element.remove();
        const link = win.document.createElementNS(NS, "link");
        link.id = "research-companion-style"; link.rel = "stylesheet";
        link.setAttribute("href", href); link.dataset.version = this.version;
        win.document.documentElement.append(link);
      }
      if (this.windows.has(win)) return;
      if (win.AbortController) this.ai.AbortController = win.AbortController;
      this.windows.add(win);
      win.MozXULElement?.insertFTLIfNeeded("research-companion.ftl");
      for (const element of win.document.querySelectorAll('[id="research-companion-menu"]')) element.remove();
      const popup = win.document.getElementById("menu_ToolsPopup");
      if (popup) {
        const menu = win.document.createXULElement("menuitem");
        menu.id = "research-companion-menu";
        menu.setAttribute("label", "LitThread · 研脉：使用说明");
        menu.addEventListener("command", () => this.Services.prompt.alert(win, "LitThread · 研脉", "选择文献或打开 PDF，在右侧“研脉 · 科研助手”中设置 API Key。\n在 PDF 选中段落后点击“问研脉”。\n选择分组后可查看本地附件、保存卡片、整理和保存分组 memory。"));
        popup.append(menu);
      }
    }
    unloadWindow(win) {
      for (const [body, view] of this.views) {
        if (body.ownerDocument.defaultView === win) { view.destroy(); this.views.delete(body); }
      }
      for (const element of win.document?.querySelectorAll('[id="research-companion-style"], [id="research-companion-menu"]') || []) element.remove();
      win.document?.querySelector('[href="research-companion.ftl"]')?.remove();
      this.windows.delete(win);
    }
    stop({ appShutdown = false } = {}) {
      this.active = false;
      const clean = action => { try { action(); } catch (error) { this.Zotero.logError?.(error); } };
      for (const view of this.views.values()) clean(() => view.destroy());
      this.views.clear();
      if (this.sectionID && !appShutdown) clean(() => this.Zotero.ItemPaneManager.unregisterSection(this.sectionID));
      // Zotero automatically removes Reader handlers by pluginID on shutdown.
      // Avoid unregisterEventListener's broken filter in the earliest 7.0 releases.
      for (const win of Array.from(this.windows)) clean(() => this.unloadWindow(win));
      this.views.clear(); this.selections.clear(); this.sessionKeys.clear();
    }
  }

  class View {
    constructor(app, { body, doc }) {
      this.app = app; this.body = body; this.doc = doc; this.epoch = 0;
      this.history = []; this.latest = null; this.busy = false; this.loading = true; this.bound = false;
      this.build();
    }
    el(tag, text, className) {
      const e = this.doc.createElementNS(NS, tag);
      if (text != null) e.textContent = text;
      if (className) e.className = className;
      // Zotero's Windows form theme opts out through these public selectors.
      // Otherwise it forces 26px fields and its own focus backgrounds.
      if (tag === "input" || tag === "textarea") e.setAttribute("no-native", "true");
      if (tag === "button") e.classList.add("btn");
      return e;
    }
    button(text, action, primary = false) {
      const b = this.el("button", text, primary ? "rc-primary" : ""); b.type = "button";
      b.addEventListener("click", () => Promise.resolve().then(action).catch(e => this.error(e)));
      return b;
    }
    icon(name) {
      const paths = {
        folder: ["M3 7V5a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z"],
        document: ["M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8Z", "M14 3v5h5M8 12h8M8 16h5"],
        bookmark: ["M6 4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17l-6-4-6 4Z"],
        settings: ["M9.5 4 10 2h4l.5 2 2 1.2 2-.5 2 3.4-1.5 1.4v2.4l1.5 1.4-2 3.4-2-.5-2 1.2-.5 2h-4l-.5-2-2-1.2-2 .5-2-3.4L5 12.5v-2.4L3.5 8.7l2-3.4 2 .5Z", "M15 10.9a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"],
        up: ["M12 19V5M6 11l6-6 6 6"], stop: ["M7 7h10v10H7Z"],
        close: ["m6 6 12 12M18 6 6 18"], back: ["M19 12H5m6-6-6 6 6 6"],
        chevron: ["m8 10 4 4 4-4"], forward: ["M5 12h14m-5-5 5 5-5 5"],
        book: ["M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Zm0 0v15"],
        notes: ["M5 3h14v18H5ZM8 8h8M8 12h8M8 16h5"],
        map: ["m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2Zm6-2v16m6-14v16"],
        refresh: ["M20 7v5h-5M4 17v-5h5", "M6.1 6a7 7 0 0 1 11.6 1L20 12M4 12l2.3 5A7 7 0 0 0 18 18"],
      };
      const icon = this.doc.createElementNS("http://www.w3.org/2000/svg", "svg");
      for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", width: "18", height: "18", fill: "none", stroke: "currentColor", "stroke-width": "1.65", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false", class: "rc-icon" })) icon.setAttribute(key, value);
      for (const d of paths[name] || paths.document) {
        const path = this.doc.createElementNS("http://www.w3.org/2000/svg", "path"); path.setAttribute("d", d); icon.append(path);
      }
      return icon;
    }
    iconButton(name, label, action, primary = false) {
      const button = this.button(null, action, primary);
      button.classList.add("rc-icon-button"); button.setAttribute("aria-label", label); button.title = label;
      button.append(this.icon(name)); return button;
    }
    label(text, input) { const l = this.el("label", text); l.append(input); return l; }
    details(title) { const d = this.el("details"); d.append(this.el("summary", title)); return d; }
    status(text, error = false) {
      this.statusBox.textContent = text; this.statusBox.title = text;
      this.statusBox.className = "rc-status" + (error ? " rc-error" : "");
      this.statusBox.hidden = !error && /^(已就绪|回答已保存|余额已刷新|已切换模型)/.test(text);
    }
    error(error) { this.status(error?.message || String(error), true); }
    build() {
      const r = this.el("div", null, "rc-root"); this.root = r;
      r.dataset.page = "chat"; r.dataset.version = this.app.version;
      const header = this.el("div", null, "rc-toolbar"); this.toolbar = header;
      const scope = this.el("div", null, "rc-scope");
      this.collectionSelect = this.el("select"); this.collectionSelect.setAttribute("aria-label", "学习分组，每个分组独立记忆");
      this.collectionSelect.title = "选择学习分组，每个分组独立记忆";
      this.collectionSelect.addEventListener("change", () => this.changeCollection().catch(e => this.error(e)));
      scope.append(this.icon("folder"), this.collectionSelect, this.icon("chevron"));
      this.saveButton = this.iconButton("bookmark", "保存回答为卡片或 memory", () => {
        this.showSettings(true); this.saveSection.open = true; this.saveSection.scrollIntoView({ block: "nearest" });
      });
      this.settingsButton = this.iconButton("settings", "打开设置", () => this.showSettings(true));
      header.append(scope, this.saveButton, this.settingsButton); r.append(header);
      this.chatPage = this.el("div", null, "rc-chat-page"); r.append(this.chatPage);
      this.chat = this.el("div", null, "rc-chat");
      this.chat.setAttribute("role", "log"); this.chat.setAttribute("aria-live", "polite");
      this.chat.setAttribute("aria-label", "对话记录"); this.chat.tabIndex = 0;
      this.chatPage.append(this.chat);

      this.composer = this.el("div", null, "rc-composer");
      const context = this.el("div", null, "rc-context-chip");
      this.title = this.el("span", "选择一篇文献开始", "rc-title");
      context.append(this.icon("document"), this.title); this.composer.append(context);
      this.selectionWrap = this.el("div", null, "rc-selection-wrap"); this.selectionWrap.hidden = true;
      this.selectionBox = this.el("div", "", "rc-selection");
      const clear = this.iconButton("close", "清除选中段落", () => { this.app.selections.delete(this.attachment?.id); this.updateSelection(); });
      this.selectionWrap.append(this.selectionBox, clear); this.composer.append(this.selectionWrap);
      this.question = this.el("textarea"); this.question.rows = 2;
      this.question.placeholder = "询问文献，或描述你的想法…";
      this.question.title = "Ctrl / ⌘ + Enter 发送；Enter 换行";
      this.question.setAttribute("aria-label", "问题或生成要求");
      this.question.addEventListener("input", () => this.updateSendState());
      this.question.addEventListener("keydown", e => {
        if (!e.isComposing && e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault(); this.send().catch(err => this.error(err));
        }
      });
      this.composer.append(this.question);
      const controls = this.el("div", null, "rc-composer-controls");
      this.mode = this.el("select"); this.mode.className = "rc-mode-select";
      this.mode.setAttribute("aria-label", "任务类型"); this.mode.title = "选择问答或知识整理任务";
      this.mode.addEventListener("change", () => this.updateSendState());
      for (const [key, label] of Object.entries(MODES)) { const opt = this.el("option", key === "chat" ? "问答" : label); opt.value = key; this.mode.append(opt); }
      this.modelSelect = this.el("select"); this.modelSelect.className = "rc-model-select";
      this.modelSelect.setAttribute("aria-label", "选择模型");
      this.modelSelect.addEventListener("change", () => { try { this.selectModel(); } catch (error) { this.error(error); } });
      this.sendButton = this.iconButton("up", "发送问题", () => this.send(), true); this.sendButton.disabled = true;
      this.sendButton.setAttribute("aria-label", "发送问题"); this.sendButton.title = "发送（Ctrl / ⌘ + Enter）";
      this.cancelButton = this.iconButton("stop", "停止生成", () => { this.controller?.abort(); }, true);
      this.cancelButton.disabled = true; this.cancelButton.hidden = true;
      for (const select of [this.mode, this.modelSelect]) {
        const menu = this.el("div", null, "rc-composer-select");
        menu.dataset.control = select === this.mode ? "task" : "model";
        menu.append(select, this.icon("chevron")); controls.append(menu);
      }
      controls.append(this.sendButton, this.cancelButton); this.composer.append(controls);
      const hint = this.el("div", null, "rc-composer-hint");
      hint.append(this.el("span", "AI 回答请核对原文"));
      this.disclosure = this.el("span", "", "rc-disclosure"); hint.append(this.disclosure);
      this.chatPage.append(this.composer, hint);

      this.settingsPage = this.el("div", null, "rc-settings-page"); this.settingsPage.hidden = true;
      const settingsHeader = this.el("div", null, "rc-settings-heading");
      this.backButton = this.iconButton("back", "返回对话", () => this.showSettings(false));
      settingsHeader.append(this.backButton, this.el("h2", "设置"), this.el("span", "v" + this.app.version, "rc-version")); this.settingsPage.append(settingsHeader);
      this.buildSettings(this.settingsPage);

      const save = this.details("回答与知识卡片"); this.saveSection = save;
      this.saveType = this.el("select");
      for (const key of ["literature-note", "claim-card", "evidence-card", "conversation"]) {
        const o = this.el("option", MODES[key] || "问答摘录"); o.value = key; this.saveType.append(o);
      }
      this.tags = this.el("input"); this.tags.placeholder = "主题:具身智能, 理论:强化学习, 方法:实验";
      save.append(this.label("卡片类型", this.saveType), this.label("标签（逗号分隔）", this.tags));
      save.append(this.button("保存最新回答为卡片", () => this.saveCard()));
      save.append(this.button("将最新脉络草稿保存为 memory", () => this.saveMemory()));
      save.append(this.el("div", "回答先作为草稿；保存 memory 时自动备份旧版本。卡片保留来源材料。", "rc-muted"));
      this.settingsPage.append(save);
      const files = this.details("当前文献 · 本地附件");
      this.filesBox = this.el("div"); files.append(this.filesBox); this.settingsPage.append(files);
      const library = this.details("分组文献与记忆文件夹");
      this.collectionInfo = this.el("div", "", "rc-muted");
      this.itemsBox = this.el("div", null, "rc-items"); this.memoryPath = this.el("div", "", "rc-path");
      library.append(this.collectionInfo, this.itemsBox, this.memoryPath);
      const folderActions = this.el("div", null, "rc-row");
      folderActions.append(this.button("打开记忆目录", () => this.openDirectory()), this.button("指定目录", () => this.chooseDirectory()));
      library.append(folderActions, this.button("恢复默认目录", async () => {
        if (!this.collection) return;
        this.app.setPref("folder." + this.collection.libraryID + "." + this.collection.key, "");
        await this.changeCollection(); this.status("已切换到默认目录。原目录中的文件保留，可手动迁移。");
      }));
      library.append(this.button("导出本组文献与附件路径", () => this.exportInventory()));
      library.append(this.button("刷新分组 / 文献", () => this.bind(this.lastProps, true)));
      library.append(this.el("div", "仅列出本组直接成员。指定目录不搬运已有文件，迁移需手动复制。", "rc-muted"));
      this.settingsPage.append(library);
      this.settingsPage.append(this.el("div", "点击发送会将问题、相关正文片段、选文、批注及本组记忆发送到配置的 API。附件路径不随请求发送。", "rc-muted"));
      const about = this.details("版本与更新");
      about.append(this.el("div", "LitThread " + this.app.version, "rc-muted"),
        this.el("p", "更新时直接在 Zotero 的“工具 → 插件 → 从文件安装”选择新版 XPI，无需先卸载。连接设置、卡片和分组 memory 会保留。当前使用手动文件更新。", "rc-muted"));
      this.settingsPage.append(about);
      r.append(this.settingsPage);
      this.statusBox = this.el("div", "准备中…", "rc-status");
      this.statusBox.setAttribute("role", "status"); this.statusBox.setAttribute("aria-live", "polite"); r.append(this.statusBox);
      this.body.replaceChildren(r);
      this.syncModels(); this.updateDisclosure(); this.renderHistory();
      this.setupLayout();
    }
    buildSettings(rootElement) {
      this.settings = this.el("section", null, "rc-connection-settings");
      const balance = this.el("div", null, "rc-balance");
      const balanceHead = this.el("div", null, "rc-balance-heading");
      this.balanceButton = this.iconButton("refresh", "刷新余额", () => this.refreshBalance());
      balanceHead.append(this.el("strong", "账户余额"), this.balanceButton);
      this.balanceBox = this.el("div", "保存 Key 后刷新，查看可用余额。", "rc-balance-content");
      balance.append(balanceHead, this.balanceBox, this.el("div", "DeepSeek · 手动刷新", "rc-muted"));
      this.settings.append(balance);
      this.settings.append(this.el("h3", "连接"));
      const config = this.app.config();
      this.baseURL = this.el("input"); this.baseURL.value = config.baseURL; this.baseURL.type = "url";
      this.model = this.el("input"); this.model.value = config.model;
      this.models = this.el("textarea"); this.models.rows = 3;
      this.models.value = this.app.modelChoices().join("\n"); this.models.placeholder = "每行一个模型名称";
      this.settingsSnapshot = { baseURL: config.baseURL, model: config.model, models: this.models.value };
      this.apiKey = this.el("input"); this.apiKey.type = "password"; this.apiKey.autocomplete = "off";
      this.apiKey.placeholder = "输入新 Key；留空保留已保存 Key";
      this.settings.append(this.label("API Key", this.apiKey), this.label("API 地址", this.baseURL), this.label("当前模型", this.model));
      const advanced = this.details("可选模型列表");
      advanced.append(this.label("每行一个模型名称，也可用逗号分隔", this.models));
      this.settings.append(advanced);
      const actions = this.el("div", null, "rc-row");
      actions.append(this.button("保存设置", () => this.saveSettings(), true), this.button("测试连接", () => this.testConnection()), this.button("清除 Key", async () => {
        const config = this.app.config(); const msg = await this.app.storeKey(config.baseURL, "");
        this.apiKey.value = ""; this.status("当前 API 地址的 Key 已清除。" + (msg.includes("不可用") ? msg : ""));
      }));
      this.settings.append(actions);
      const help = this.details("连接与隐私说明");
      help.append(this.el("p", "Key 保存在本机 Zotero 登录管理器中。测试连接只发送测试消息，刷新余额不附带文献。模型列表由你维护，请填写服务支持的名称。", "rc-muted"));
      this.settings.append(help);
      rootElement.append(this.settings);
    }
    showSettings(show = true) {
      if (show) this.refreshSettings();
      this.chatPage.hidden = show; this.settingsPage.hidden = !show;
      this.toolbar.hidden = show;
      this.settingsButton.hidden = show; this.saveButton.hidden = show;
      this.root.dataset.page = show ? "settings" : "chat";
      if (show) this.backButton.focus({ preventScroll: true });
      else this.question.focus({ preventScroll: true });
      this.scheduleLayout?.();
    }
    syncModels() {
      if (!this.modelSelect) return;
      const current = this.app.config().model;
      this.modelSelect.replaceChildren();
      for (const name of this.app.modelChoices()) {
        const option = this.el("option", name); option.value = name; this.modelSelect.append(option);
      }
      this.modelSelect.value = current; this.modelSelect.title = "当前模型：" + current;
      this.refreshSettings();
    }
    refreshSettings() {
      const config = this.app.config();
      const next = { baseURL: config.baseURL, model: config.model, models: this.app.modelChoices().join("\n") };
      // Synchronize unchanged controls across reader tabs without erasing edits
      // the user is still making in another settings page.
      for (const field of ["baseURL", "model", "models"]) {
        if (!this.settingsSnapshot || this[field].value === this.settingsSnapshot[field]) this[field].value = next[field];
      }
      this.settingsSnapshot = next;
    }
    selectModel() {
      const model = this.modelSelect.value.trim();
      if (!model || model.length > 128) throw new Error("请选择有效的模型。");
      this.app.setPref("model", model);
      this.model.value = model;
      for (const view of this.app.views.values()) view.syncModels();
      this.syncModels(); this.status("已切换模型：" + model);
    }
    setupLayout() {
      const win = this.doc.defaultView;
      this.scheduleLayout = () => {
        if (this.destroyed || this.layoutFrame != null) return;
        this.layoutFrame = win.requestAnimationFrame(() => {
          this.layoutFrame = null;
          if (this.destroyed || !this.root.isConnected || !this.root.getClientRects().length) return;
          const rect = this.root.getBoundingClientRect();
          if (rect.width <= 0) return;
          // The reader splitter changes the section width without resizing its
          // window. Keep width and height modes independent, and never rebuild
          // messages or controls while the user drags that splitter.
          const widthLayout = rect.width < 320 ? "narrow" : rect.width < 460 ? "normal" : "wide";
          if (this.root.dataset.widthLayout !== widthLayout) this.root.dataset.widthLayout = widthLayout;
          const panelWidth = String(Math.round(rect.width));
          if (this.root.dataset.panelWidth !== panelWidth) this.root.dataset.panelWidth = panelWidth;
          const pane = this.body.closest("item-details");
          const bottom = Math.min(win.innerHeight, pane?.getBoundingClientRect().bottom || win.innerHeight);
          const height = Math.max(200, Math.min(1200, bottom - Math.max(0, rect.top) - 8));
          const compact = String(height < 400);
          if (this.root.dataset.compact !== compact) this.root.dataset.compact = compact;
          if (Math.abs(rect.height - height) > 2) this.root.style.height = height + "px";
        });
      };
      win.addEventListener("resize", this.scheduleLayout);
      this.scrollContainer = this.body.closest("item-details");
      this.layoutScroll = event => { if (!this.root.contains(event.target)) this.scheduleLayout(); };
      this.scrollContainer?.addEventListener("scroll", this.layoutScroll, true);
      if (win.ResizeObserver) {
        this.resizeObserver = new win.ResizeObserver(this.scheduleLayout);
        // Observe the actual view and its host, including a hidden section
        // becoming visible or Zotero moving the pane below the PDF.
        for (const node of new Set([this.root, this.body, this.scrollContainer])) {
          if (node) this.resizeObserver.observe(node);
        }
      }
      if (win.IntersectionObserver) {
        this.layoutObserver = new win.IntersectionObserver(this.scheduleLayout, { threshold: [0, 0.5, 1] });
        this.layoutObserver.observe(this.root);
      }
      this.scheduleLayout();
    }
    updateDisclosure() {
      let host;
      try { host = new URL(this.app.config().baseURL).host; } catch (_) { host = this.app.config().baseURL; }
      this.disclosure.textContent = host;
      this.disclosure.title = "点击发送会将问题、相关正文片段、选文、批注和本组记忆发送至 " + this.app.config().baseURL + "。附件路径不随请求发送。";
    }
    resetBalance() {
      this.balanceSequence = (this.balanceSequence || 0) + 1;
      this.balanceController?.abort(); this.balanceController = null;
      if (this.balanceBox) this.balanceBox.textContent = "保存 Key 后刷新，查看可用余额。";
    }
    async refreshBalance() {
      if (this.balanceBusy) return;
      this.balanceBusy = true; this.balanceButton.disabled = true;
      let sequence;
      try {
        await this.saveSettings();
        sequence = this.balanceSequence = (this.balanceSequence || 0) + 1;
        const config = this.app.config(), credentialVersion = this.app.credentialVersion;
        const apiKey = await this.app.key(config.baseURL);
        if (sequence !== this.balanceSequence || !this.root.isConnected) return;
        if (!apiKey) throw new Error("请先在设置中填写并保存 API Key。");
        this.balanceController = new this.doc.defaultView.AbortController();
        this.balanceBox.textContent = "正在查询账户余额…";
        const result = await this.app.ai.balance({ ...config, apiKey, signal: this.balanceController.signal });
        if (sequence !== this.balanceSequence || !this.root.isConnected
          || config.baseURL !== this.app.config().baseURL || credentialVersion !== this.app.credentialVersion) return;
        this.balanceBox.replaceChildren();
        if (!result.balances.length) this.balanceBox.append(this.el("div", "服务商未返回余额明细，不能视为 0。", "rc-muted"));
        for (const entry of result.balances) {
          this.balanceBox.append(this.el("div", entry.currency + " " + entry.total, "rc-balance-total"),
            this.el("div", "充值 " + entry.toppedUp + " · 赠送 " + entry.granted, "rc-muted"));
        }
        this.balanceBox.append(this.el("div", (result.isAvailable ? "账户可用" : "余额不足，暂不可调用")
          + " · 更新于 " + new Date().toLocaleTimeString(), "rc-muted"));
        this.status("余额已刷新；金额以服务商账户返回为准。");
      } catch (error) {
        if (sequence === undefined || sequence === this.balanceSequence) {
          this.balanceBox.textContent = "余额查询失败：" + (error?.message || String(error));
          this.error(error);
        }
      } finally {
        this.balanceBusy = false; this.balanceButton.disabled = false; this.balanceController = null;
      }
    }
    invalidate() {
      this.epoch++; this.controller?.abort(); this.controller = null; this.busy = false;
      this.loading = true; this.bound = false;
      this.sendButton.disabled = true; this.cancelButton.disabled = true;
      this.pendingQuestion = null; this.sendButton.hidden = false; this.cancelButton.hidden = true;
      if (this.modelSelect) this.modelSelect.disabled = false;
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.invalidate();
      this.resetBalance();
      const win = this.doc.defaultView;
      win.removeEventListener("resize", this.scheduleLayout);
      this.scrollContainer?.removeEventListener("scroll", this.layoutScroll, true);
      this.layoutObserver?.disconnect();
      this.resizeObserver?.disconnect();
      if (this.layoutFrame != null) win.cancelAnimationFrame(this.layoutFrame);
      this.layoutFrame = null;
      this.root.remove();
    }
    current(token) { return this.app.active && token === this.epoch; }
    async bind(props, force = false) {
      props = props || {};
      this.lastProps = props;
      let targetID = props.item?.id;
      if (props.tabType === "reader") {
        const tabID = this.body.closest("item-details")?.tabID;
        const reader = this.doc.defaultView.reader || (tabID && this.app.Zotero.Reader.getByTabID(tabID));
        // Reader hooks generally receive the parent bibliographic item. Only the
        // exact reader/tab identifies which PDF is open when an item has several.
        const tabItemID = tabID && this.doc.defaultView.Zotero_Tabs?._getTab?.(tabID)?.tab?.data?.itemID;
        targetID = reader?.itemID || tabItemID || (props.item?.isAttachment?.() ? props.item.id : null);
      }
      if (!force && targetID && this.bound && this.targetID === targetID && this.hookItemID === props.item?.id) return;
      this.invalidate(); const token = this.epoch;
      this.targetID = targetID; this.hookItemID = props.item?.id;
      this.latest = null; this.history = []; this.chat.replaceChildren(); this.question.value = "";
      this.item = null; this.meta = null; this.attachment = null; this.collection = null; this.saved = null;
      this.collections = []; this.collectionItems = [];
      this.collectionSelect.replaceChildren(); this.filesBox.replaceChildren(); this.itemsBox.replaceChildren();
      this.memoryPath.textContent = ""; this.collectionInfo.textContent = "";
      this.updateSelection();
      if (!targetID) {
        this.title.textContent = props.tabType === "reader" ? "阅读器尚未就绪" : "请选择文献";
        this.status(props.tabType === "reader" ? "尚未确定当前阅读的附件；请稍后点击“刷新分组 / 文献”。" : "选择一篇文献后开始。");
        return;
      }
      this.title.textContent = "正在读取文献…";
      this.status("正在读取当前文献与学习分组…");
      const target = targetID === props.item?.id ? props.item : await this.app.Zotero.Items.getAsync(targetID);
      if (!this.current(token)) return;
      const resolved = await this.app.data.resolveItem(target);
      if (!this.current(token)) return;
      const item = resolved.parent || resolved.item;
      if (!item) { this.title.textContent = "文献已不可用"; this.status("文献可能已删除；请选择其他文献。"); return; }
      const meta = await this.app.data.metadata(item);
      if (!this.current(token)) return;
      const collections = await this.app.data.listCollections(item.libraryID);
      if (!this.current(token)) return;
      this.item = item; this.meta = meta; this.attachment = resolved.attachment; this.collections = collections;
      this.title.textContent = this.meta.title; this.title.title = this.meta.title;
      this.updateSelection();
      const membership = item.getCollections?.() || [];
      const pane = this.doc.defaultView.ZoteroPane || this.app.Zotero.getActiveZoteroPane?.();
      // Zotero 10 supports multiple collection rows and its legacy singular
      // getter can throw. Pick a selected collection that actually contains
      // this paper; continue using the singular getter on Zotero 7–9.
      const selected = typeof pane?.getSelectedCollections === "function"
        ? pane.getSelectedCollections() : [pane?.getSelectedCollection?.()].filter(Boolean);
      const selectedIDs = new Set(selected.map(c => c.id));
      const preferred = collections.find(c => selectedIDs.has(c.id) && membership.includes(c.id)) || collections.find(c => membership.includes(c.id));
      this.collectionSelect.replaceChildren();
      const empty = this.el("option", "未分组文献"); empty.value = ""; this.collectionSelect.append(empty);
      for (const c of collections) {
        const opt = this.el("option", c.path); opt.value = String(c.id); opt.title = membership.includes(c.id) ? "包含当前文献 · " + c.path : c.path; this.collectionSelect.append(opt);
      }
      this.collectionSelect.value = preferred ? String(preferred.id) : "";
      await this.renderFiles();
      if (this.current(token)) await this.changeCollection();
    }
    updateSelection() {
      const selection = this.app.selections.get(this.attachment?.id);
      if (this.selectionWrap) this.selectionWrap.hidden = !selection;
      this.selectionBox.textContent = selection ? (selection.pageLabel ? "第 " + selection.pageLabel + " 页 · " : "已选中 · ") + selection.text : "在 PDF 中选中文字，点击“问研脉”。也可在问题框粘贴段落。";
    }
    async renderFiles() {
      const token = this.epoch;
      const attachments = await this.app.data.attachments(this.item);
      if (!this.current(token)) return;
      this.filesBox.replaceChildren();
      for (const file of attachments) {
        const row = this.el("div", null, "rc-file");
        row.append(this.el("strong", file.title || file.key), this.el("div", file.path
          ? file.path + (file.exists ? "" : "\n（文件当前不存在，请在 Zotero 中下载或重新定位。）")
          : "附件未下载、已移动或仅有远程链接", "rc-path"));
        if (file.exists && file.path) row.append(this.button("在文件管理器中显示", () => this.app.Zotero.File.reveal(file.path)));
        this.filesBox.append(row);
      }
      if (!attachments.length) this.filesBox.textContent = "该条目没有本地附件。";
    }
    async changeCollection() {
      if (!this.item || !this.meta) return;
      const item = this.item, itemKey = this.meta.key;
      this.invalidate(); const token = this.epoch;
      this.latest = null; this.saved = null; this.history = []; this.chat.replaceChildren();
      this.collectionItems = [];
      this.itemsBox.replaceChildren(); this.memoryPath.textContent = ""; this.collectionInfo.textContent = "";
      const id = Number(this.collectionSelect.value);
      this.collection = this.collections.find(c => c.id === id) || { id: null, key: "unfiled", libraryID: item.libraryID, name: "未分组文献", path: "未分组文献" };
      const collection = this.collection; const folder = this.app.rootFor(collection);
      this.status("正在读取分组与记忆…");
      let items = await this.app.data.listItems(collection.id, collection.libraryID);
      if (!this.current(token)) return;
      if (!collection.id) {
        items = items.filter(meta => !(this.app.Zotero.Items.get(meta.id)?.getCollections?.() || []).length);
      }
      const [saved, history] = await Promise.all([
        this.app.memory.read(collection, folder),
        this.app.memory.readConversation(collection, itemKey, folder),
      ]);
      if (!this.current(token)) return;
      this.saved = saved; this.history = history; this.collectionItems = items;
      this.memoryPath.textContent = saved.directory;
      this.collectionInfo.textContent = `${collection.path || collection.name} · ${items.length} 篇文献 · ${saved.records.length} 张卡片`;
      this.itemsBox.replaceChildren();
      for (const meta of items.slice(0, 200)) {
        this.itemsBox.append(this.button((meta.year ? meta.year + " · " : "") + meta.title, async () => {
          const pane = this.app.Zotero.getActiveZoteroPane();
          await pane.selectItem(meta.id);
        }));
      }
      if (items.length > 200) this.itemsBox.append(this.el("div", `仅展示前 200 篇；导出包含全部 ${items.length} 篇。`, "rc-muted"));
      this.loading = false; this.bound = true; this.updateSendState();
      this.renderHistory(); this.status("已就绪 · 对话保存在当前分组");
      this.scheduleLayout?.();
    }
    renderHistory() {
      this.chat.replaceChildren();
      if (!this.history.length && !this.pendingQuestion) {
        const empty = this.el("div", null, "rc-empty");
        const illustration = this.el("div", null, "rc-empty-icon"); illustration.append(this.icon("book"));
        empty.append(illustration, this.el("div", "一起读懂这篇文献", "rc-empty-title"),
          this.el("p", "从一个问题开始，\n让每次阅读都有积累。"));
        const prompts = this.el("div", null, "rc-prompts");
        for (const [icon, label, mode, question] of [["book", "解释核心观点", "chat", "这篇文献研究什么问题？请解释核心方法与结论，并标明依据。"],
          ["notes", "整理阅读笔记", "literature-note", ""], ["map", "梳理研究脉络", "genealogy", ""]]) {
          const button = this.button(null, () => { this.mode.value = mode; this.question.value = question; this.updateSendState(); this.question.focus(); });
          button.append(this.icon(icon), this.el("span", label), this.icon("forward")); prompts.append(button);
        }
        empty.append(prompts); this.chat.append(empty);
      }
      const messages = [...this.history];
      if (this.pendingQuestion) messages.push({ role: "user", content: this.pendingQuestion });
      let questionBox = null;
      for (const msg of messages) {
        const box = this.el("div", null, "rc-message"); box.dataset.role = msg.role;
        box.setAttribute("aria-label", msg.role === "user" ? "你的问题" : "助手回答");
        const prose = this.el("div", null, "rc-prose");
        if (msg.role === "assistant") {
          prose.append(root.RCMarkdown.render(this.doc, msg.content, { onOpenLink: href => this.app.Zotero.launchURL(href) }));
        } else {
          prose.textContent = msg.content; prose.classList.add("rc-plain-text");
          if (msg.role === "user") { questionBox = box; box.tabIndex = -1; }
        }
        box.append(this.el("div", msg.role === "user" ? "你" : "研脉", "rc-message-head"), prose);
        if (msg.role === "assistant" && questionBox) {
          const target = questionBox;
          const actions = this.el("div", null, "rc-message-actions");
          const jump = this.button(null, () => this.jumpToQuestion(target));
          jump.classList.add("rc-jump-to-question");
          jump.title = "回到这条回答对应的提问";
          jump.append(this.icon("up"), this.el("span", "回到本轮提问"));
          actions.append(jump); box.append(actions);
        }
        this.chat.append(box);
      }
      if (this.pendingQuestion) {
        const pending = this.el("div", "正在整理回答…", "rc-pending"); pending.setAttribute("role", "status"); this.chat.append(pending);
      }
      this.chat.scrollTop = this.chat.scrollHeight;
    }
    jumpToQuestion(target) {
      if (!target?.isConnected || !this.chat.contains(target)) return;
      // Scroll only the conversation, keeping the PDF and outer item pane still.
      const top = this.chat.scrollTop + target.getBoundingClientRect().top
        - this.chat.getBoundingClientRect().top - this.chat.clientTop - 8;
      this.chat.scrollTop = Math.max(0, top);
      target.focus({ preventScroll: true });
    }
    async saveSettings() {
      const previousURL = this.app.config().baseURL;
      const baseURL = root.RCAI.validateBaseURL(this.baseURL.value);
      const model = this.model.value.trim();
      if (!model || model.length > 128) throw new Error("请输入有效的模型名称。");
      const models = [...new Set(this.models.value.split(/[,，\n]/).map(value => value.trim()).filter(Boolean))];
      if (models.length > 50 || models.some(value => value.length > 128)) throw new Error("最多保存 50 个模型，每个名称不超过 128 字符。");
      let message = "连接设置已保存。";
      if (this.apiKey.value.trim()) message += await this.app.storeKey(baseURL, this.apiKey.value.trim());
      this.app.setPref("baseURL", baseURL); this.app.setPref("model", model);
      this.app.setPref("models", models.join("\n"));
      if (baseURL !== previousURL) for (const view of this.app.views.values()) view.resetBalance();
      this.apiKey.value = ""; this.baseURL.value = baseURL; this.model.value = model;
      for (const view of this.app.views.values()) { view.updateDisclosure(); view.syncModels(); }
      this.syncModels(); this.models.value = this.app.modelChoices().join("\n");
      this.settingsSnapshot = { baseURL, model, models: this.models.value };
      this.status(message);
    }
    async testConnection() {
      if (this.busy) return;
      await this.saveSettings();
      const config = this.app.config(); const apiKey = await this.app.key(config.baseURL);
      if (!apiKey) throw new Error("请先输入 API Key 并保存。");
      const token = this.epoch;
      this.startBusy();
      this.controller = new this.doc.defaultView.AbortController(); this.status("正在测试连接（只发送测试消息）…");
      try {
        const result = await this.app.ai.complete({ ...config, apiKey, messages: [{ role: "user", content: "请只回复：连接成功。" }], maxTokens: 128, signal: this.controller.signal });
        if (this.current(token)) this.status("连接成功 · " + result.model + "\n" + result.text);
      } catch (error) {
        if (this.current(token)) throw error;
      } finally { if (this.current(token)) this.finish(); }
    }
    updateSendState() {
      this.sendButton.disabled = !!(this.loading || this.busy || (!this.question.value.trim() && !QUESTIONS[this.mode?.value]));
    }
    startBusy() {
      this.busy = true; this.sendButton.disabled = true; this.sendButton.hidden = true;
      this.cancelButton.disabled = false; this.cancelButton.hidden = false;
      this.modelSelect.disabled = true;
    }
    finish() {
      this.busy = false; this.controller = null; this.pendingQuestion = null;
      this.updateSendState(); this.sendButton.hidden = false;
      this.cancelButton.disabled = true; this.cancelButton.hidden = true; this.modelSelect.disabled = false;
      this.renderHistory();
    }
    async send() {
      if (this.busy || this.loading) return;
      if (!this.item || !this.collection || !this.saved) throw new Error("请等待文献与分组加载完成。");
      const mode = this.mode.value;
      const draft = this.question.value;
      const question = draft.trim() || QUESTIONS[mode];
      if (!question) throw new Error("请输入问题，或选择生成文献笔记等任务。");
      const token = this.epoch;
      const config = this.app.config(); const apiKey = await this.app.key(config.baseURL);
      if (!this.current(token) || this.busy || this.loading) return;
      if (!apiKey) { this.showSettings(true); this.apiKey.focus(); throw new Error("请先在设置 → 模型连接中保存 API Key。"); }
      const collection = this.collection, folder = this.app.rootFor(collection), item = this.meta;
      const selectionObject = this.app.selections.get(this.attachment?.id);
      const selection = selectionObject ? (selectionObject.pageLabel ? `[选中段落，第 ${selectionObject.pageLabel} 页]\n` : "") + selectionObject.text : "";
      this.controller = new this.doc.defaultView.AbortController();
      this.startBusy();
      this.latest = null; this.pendingQuestion = question; this.renderHistory();
      this.status("正在提取当前文献并检索相关片段…");
      try {
        const read = await this.app.data.readText(this.attachment || this.item);
        const annotations = this.attachment ? await this.app.data.annotations(this.attachment) : [];
        const saved = await this.app.memory.read(collection, folder);
        if (!this.current(token)) return;
        if (this.controller.signal.aborted) throw new Error("请求已取消。");
        const cards = saved.records.slice(-30).reverse().map(record => `[已保存卡片 ${record.type} · ${record.item?.key || ""} · ${record.item?.title || ""}]\n${String(record.content || "").slice(0, 1800)}`).join("\n\n").slice(0, 4000);
        const history = await this.app.memory.readConversation(collection, item.key, folder);
        if (!this.current(token) || this.controller.signal.aborted) return;
        const messages = root.RCAI.buildMessages({ question, item, text: read.text, selection, annotations,
          memory: saved.memory.slice(0, 5500) + "\n\n最近卡片：\n" + cards, history, mode,
          collectionItems: mode === "genealogy" ? this.collectionItems : [],
        });
        this.status((read.warning ? read.warning + "\n" : "") + "正在请求 " + config.model + "…（正文为相关片段，未声称读取整篇全文）");
        const result = await this.app.ai.complete({ ...config, apiKey, messages, signal: this.controller.signal });
        if (!this.current(token) || this.controller.signal.aborted) return;
        const content = result.text + (result.truncated ? "\n\n[回答达到输出上限，请缩小问题或继续提问。]" : "");
        const sources = JSON.parse(messages[1].content.slice(messages[1].content.indexOf("{")));
        this.latest = { mode, content, question, selection, item, collection, folder, sources };
        const turns = [{ role: "user", content: question + (selection ? "\n\n" + selection : "") }, { role: "assistant", content }];
        this.history = [...history, ...turns].slice(-40);
        this.pendingQuestion = null; this.renderHistory();
        if (this.question.value === draft) this.question.value = "";
        if (mode in QUESTIONS && mode !== "genealogy") this.saveType.value = mode;
        const persisted = await this.app.memory.appendConversation(collection, item.key, turns, folder);
        if (this.current(token)) { this.history = persisted.messages; this.renderHistory(); }
        if (this.current(token)) this.status((read.warning ? read.warning + "\n" : "") + "回答已保存到本组对话。可继续提问，或保存为卡片。" + (mode === "genealogy" ? "知识脉络草稿可保存为 memory。" : ""));
      } catch (error) {
        if (this.current(token)) throw error;
      } finally { if (this.current(token)) this.finish(); }
    }
    async saveCard() {
      const answer = this.latest;
      if (!answer) throw new Error("先发送问题或生成内容，然后保存最新回答。");
      const result = await this.app.memory.saveRecord(answer.collection, {
        type: this.saveType.value, item: answer.item, content: answer.content,
        question: answer.question, selection: answer.selection,
        sources: answer.sources,
        tags: this.tags.value.split(/[,，\n]/).map(t => t.trim()).filter(Boolean),
      }, answer.folder);
      this.status("卡片已保存：\n" + result.recordPath);
    }
    async saveMemory() {
      const answer = this.latest;
      if (!answer || answer.mode !== "genealogy") throw new Error("请先选择“分组知识脉络”并生成草稿，再保存为 memory。");
      const result = await this.app.memory.saveSynthesis(answer.collection, answer.content, answer.folder);
      this.status("已保存本组 memory" + (result.backupPath ? "，旧版本已备份" : "") + "：\n" + result.memoryPath);
    }
    async openDirectory() {
      if (!this.collection) return;
      const folder = await this.app.memory.directory(this.collection, this.app.rootFor(this.collection));
      await this.app.IOUtils.makeDirectory(folder, { createAncestors: true, ignoreExisting: true });
      this.app.Zotero.launchFile(this.app.Zotero.File.pathToFile(folder));
    }
    async chooseDirectory() {
      if (!this.collection) return;
      const { FilePicker } = this.app.ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
      const picker = new FilePicker(); picker.init(this.doc.defaultView, "选择本分组记忆的根目录", picker.modeGetFolder);
      const token = this.epoch, collection = this.collection;
      if (await picker.show() !== picker.returnOK || !this.current(token)) return;
      this.app.setPref("folder." + collection.libraryID + "." + collection.key, picker.file);
      await this.changeCollection(); this.status("已切换记忆目录。旧文件保留；迁移时请手动复制该分组目录。");
    }
    async exportInventory() {
      if (!this.collection) return;
      const collection = this.collection, folder = this.app.rootFor(collection), token = this.epoch;
      const inventory = [];
      this.status("正在导出本组文献与附件路径…");
      for (const meta of this.collectionItems) {
        if (!this.current(token)) return;
        inventory.push({ ...meta, attachments: await this.app.data.attachments(meta.id) });
      }
      const result = await this.app.memory.exportInventory(collection, inventory, folder);
      if (this.current(token)) this.status("已导出（路径仅保存在本地文件）：\n" + result.jsonPath + "\n" + result.markdownPath);
    }
  }
  root.RCApp = RCApp;
  if (typeof module !== "undefined" && module.exports) module.exports = { RCApp, View };
})(globalThis);
