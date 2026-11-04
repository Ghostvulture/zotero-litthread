/* Local, collection-scoped storage. Compatible with Zotero 7's privileged JS. */
(function (root) {
  "use strict";

  const locks = new Map();
  let sequence = 0;
  const folders = Object.freeze({
    "literature-note": "notes",
    "claim-card": "claims",
    "evidence-card": "evidence",
    conversation: "conversations",
  });
  const labels = Object.freeze({
    "literature-note": "文献笔记",
    "claim-card": "观点卡片",
    "evidence-card": "论证素材",
    conversation: "阅读对话",
  });

  function string(value) {
    return value == null ? "" : String(value);
  }

  // Encode separators and percent signs injectively, so two unusual keys cannot
  // map to the same filename. Stable Zotero keys remain readable.
  function safeKey(value) {
    const key = string(value);
    if (!key || key.length > 128) throw new Error("Invalid or excessively long storage key");
    const encoded = Array.from(key, ch => /^[A-Za-z0-9_-]$/.test(ch)
      ? ch : "%" + ch.codePointAt(0).toString(16).padStart(6, "0")).join("");
    if (encoded.length > 180) throw new Error("Storage key exceeds portable filename limits");
    return encoded;
  }

  function uniqueID() {
    return Date.now().toString(36) + "-" + (++sequence).toString(36)
      + "-" + Math.random().toString(36).slice(2, 10);
  }

  function scalarLine(value) {
    return string(value).replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|");
  }

  function authorText(author) {
    if (typeof author === "string") return author;
    if (!author || typeof author !== "object") return "";
    return string(author.name || [author.firstName, author.lastName].filter(Boolean).join(" "));
  }

  // Deliberately whitelist fields: callers may pass other runtime state, which
  // must never cause credentials or settings to enter a library export.
  function cleanItem(item = {}) {
    if (!item || typeof item !== "object") throw new Error("Literature metadata must be an object");
    const result = {};
    for (const field of ["key", "title", "year", "doi", "citation", "zoteroURI", "url", "abstract"]) {
      if (item[field] != null) result[field] = string(item[field]);
    }
    if (["number", "string"].includes(typeof item.libraryID)) result.libraryID = item.libraryID;
    if (Array.isArray(item.authors)) result.authors = item.authors.map(authorText).filter(Boolean);
    else if (item.authors != null) result.authors = [string(item.authors)];
    if (Array.isArray(item.tags)) result.tags = item.tags.map(tag => string(tag && tag.tag || tag));
    return result;
  }

  function cleanInventoryItem(item) {
    const result = cleanItem(item);
    if (Array.isArray(item.localPaths)) result.localPaths = item.localPaths.map(string);
    if (item.localPath != null) result.localPath = string(item.localPath);
    if (Array.isArray(item.attachments)) {
      result.attachments = item.attachments.map(attachment => {
        const clean = {};
        for (const field of ["key", "title", "path", "localPath", "contentType"]) {
          if (attachment[field] != null) clean[field] = string(attachment[field]);
        }
        if (typeof attachment.exists === "boolean") clean.exists = attachment.exists;
        return clean;
      });
    }
    return result;
  }

  function validMessage(message) {
    return message && ["user", "assistant"].includes(message.role)
      && typeof message.content === "string";
  }

  function cleanSourceText(value) {
    return string(value)
      .replace(/\u0000/g, "")
      .replace(/file:\/\/[^\s<>"']+/gi, "[本地路径已隐藏]")
      .replace(/[A-Za-z]:[\\/][^\r\n<>"']+/g, "[本地路径已隐藏]")
      .replace(/\\\\[^\s\\]+\\[^\r\n<>"']+/g, "[本地路径已隐藏]")
      .replace(/(^|[\s("'=])\/(?:[^\s/<>"']+\/)+[^\s<>"']*/gm, "$1[本地路径已隐藏]")
      .replace(/\bsk-[a-zA-Z0-9_-]{8,}\b/g, "[密钥已隐藏]")
      .replace(/\bBearer\s+[^\s"',;]+/gi, "Bearer [密钥已隐藏]")
      .replace(/(api[_ -]?key\s*[:=]\s*)[^\s"',;]+/gi, "$1[密钥已隐藏]");
  }

  // Store the finite research-material packet, never arbitrary caller state.
  // The index only stores a relative filename so large packets are not duplicated.
  function cleanSources(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Source materials must be a research packet object");
    }
    const copyTextFields = (source, fields) => {
      const result = {};
      if (!source || typeof source !== "object") return result;
      for (const field of fields) {
        if (["string", "number", "boolean"].includes(typeof source[field])) {
          result[field] = cleanSourceText(source[field]);
        }
      }
      return result;
    };
    const metadata = source => copyTextFields(source,
      ["title", "date", "DOI", "doi", "key", "itemType", "publicationTitle", "creators", "year", "tags", "abstract", "citation"]);
    const packet = copyTextFields(input, ["scope", "fulltext_status", "collection_scope", "collection_coverage"]);
    if (input.current_item) {
      packet.current_item = { ...copyTextFields(input.current_item, ["source_id"]),
        bibliographic_metadata: metadata(input.current_item.bibliographic_metadata) };
    }
    for (const field of ["selected_text", "annotations", "memory"]) {
      if (input[field] === null) packet[field] = null;
      else if (input[field]) packet[field] = copyTextFields(input[field], ["source_id", "text", "status"]);
    }
    if (Array.isArray(input.excerpts)) {
      packet.excerpts = input.excerpts.map(excerpt => copyTextFields(excerpt, ["source_id", "text"]));
    }
    if (Array.isArray(input.collection_items)) {
      packet.collection_items = input.collection_items.map(item => ({
        ...copyTextFields(item, ["source_id"]), metadata: metadata(item && item.metadata),
      }));
    }
    if (Array.isArray(input.related_documents)) {
      packet.related_documents = input.related_documents.map(document => ({
        ...copyTextFields(document, ["source_id", "status"]), metadata: metadata(document.metadata),
        excerpts: (Array.isArray(document.excerpts) ? document.excerpts : []).map(excerpt => copyTextFields(excerpt, ["source_id", "text"]))
      }));
    }
    if (Array.isArray(input.previous_conversation)) {
      packet.previous_conversation = input.previous_conversation.filter(validMessage)
        .map(message => ({ role: message.role, content: cleanSourceText(message.content) }));
    }
    return packet;
  }

  class RCMemory {
    constructor({ IOUtils, PathUtils, Zotero }) {
      if (!IOUtils || !PathUtils || !Zotero) throw new Error("Memory storage dependencies are required");
      this.io = IOUtils;
      this.paths = PathUtils;
      this.zotero = Zotero;
    }

    _collection(collection) {
      return {
        key: collection ? string(collection.key || collection.id) : "unfiled",
        name: collection ? string(collection.name) : "未分类文献",
        libraryID: collection && collection.libraryID != null
          ? collection.libraryID : this.zotero.Libraries && this.zotero.Libraries.userLibraryID || 1,
      };
    }

    async directory(collection, rootOverride = "") {
      const scope = this._collection(collection);
      const base = rootOverride ? string(rootOverride)
        : this.paths.join(this.zotero.DataDirectory.dir, "research-companion");
      return this.paths.join(base, "library-" + safeKey(scope.libraryID),
        collection ? "collection-" + safeKey(scope.key) : "unfiled");
    }

    async _locked(directory, callback) {
      const previous = locks.get(directory) || Promise.resolve();
      const current = previous.catch(() => {}).then(callback);
      locks.set(directory, current);
      try {
        return await current;
      } finally {
        if (locks.get(directory) === current) locks.delete(directory);
      }
    }

    async _mkdir(directory) {
      await this.io.makeDirectory(directory, { createAncestors: true, ignoreExisting: true });
    }

    async _atomic(path, contents, mode = "overwrite") {
      await this.io.writeUTF8(path, contents, {
        tmpPath: path + ".tmp-" + uniqueID(), mode, flush: true,
      });
    }

    async _text(path) {
      return await this.io.exists(path) ? this.io.readUTF8(path) : "";
    }

    async _json(path) {
      if (!await this.io.exists(path)) return undefined;
      const contents = await this.io.readUTF8(path);
      try {
        return JSON.parse(contents);
      } catch (cause) {
        const error = new Error("Cannot read damaged JSON; original file was preserved: " + path);
        error.cause = cause;
        throw error;
      }
    }

    async _records(directory) {
      const path = this.paths.join(directory, "records.json");
      const data = await this._json(path);
      if (data === undefined) return [];
      if (!data || data.schemaVersion !== 1 || !Array.isArray(data.records)
        || data.records.some(record => !record || typeof record.id !== "string"
          || !Object.hasOwn(folders, record.type) || typeof record.content !== "string")) {
        throw new Error("Unsupported or damaged records index; original file was preserved: " + path);
      }
      return data.records;
    }

    async read(collection, rootOverride = "") {
      const directory = await this.directory(collection, rootOverride);
      return this._locked(directory, async () => ({
        directory,
        memory: await this._text(this.paths.join(directory, "memory.md")),
        records: await this._records(directory),
      }));
    }

    _recordMarkdown(record) {
      const item = record.item;
      const lines = ["# " + labels[record.type] + "：" + scalarLine(item.title || "未命名文献"), "",
        "- 创建时间：" + record.createdAt,
        "- 卡片编号：" + scalarLine(record.id),
        "- 文献：" + scalarLine(item.citation || item.title || item.key),
        "- 作者：" + scalarLine((item.authors || []).join("; ")),
        "- 年份：" + scalarLine(item.year),
        "- DOI：" + scalarLine(item.doi),
        "- Zotero：" + scalarLine(item.zoteroURI),
        "- 标签：" + record.tags.map(scalarLine).join(", "), ""];
      if (record.question) lines.push("## 问题", "", record.question, "");
      if (record.selection) lines.push("## 选中文本", "",
        record.selection.split("\n").map(line => "> " + line).join("\n"), "");
      if (record.sourcesPath) lines.push("## 来源材料", "",
        "[查看本次材料包](./" + record.sourcesPath.split("/").pop() + ")", "",
        "本材料包保存本次请求提供的有限节选，可查找 [F001] 等来源编号；编号不是 PDF 页码。AI 内容仍需核对原文。", "");
      lines.push("## 内容", "", record.content, "");
      return lines.join("\n");
    }

    async saveRecord(collection, input, rootOverride = "") {
      if (!input || !Object.hasOwn(folders, input.type) || typeof input.content !== "string") {
        throw new Error("A supported record type and text content are required");
      }
      const directory = await this.directory(collection, rootOverride);
      return this._locked(directory, async () => {
        // Validate before creating any new file if the existing index is damaged.
        const records = await this._records(directory);
        const record = {
          id: input.id ? string(input.id) : uniqueID(), type: input.type,
          item: cleanItem(input.item), content: input.content,
          question: string(input.question), selection: string(input.selection),
          createdAt: input.createdAt ? string(input.createdAt) : new Date().toISOString(),
          tags: Array.isArray(input.tags) ? input.tags.map(string) : [],
        };
        if (records.some(existing => existing.id === record.id)) throw new Error("Record ID already exists");
        const folder = this.paths.join(directory, folders[record.type]);
        const basename = "card-" + safeKey(record.id);
        const recordPath = this.paths.join(folder, basename + ".md");
        const indexPath = this.paths.join(directory, "records.json");
        const sources = input.sources == null ? null : cleanSources(input.sources);
        const sourcesPath = sources ? this.paths.join(folder, basename + ".sources.json") : null;
        if (sources) record.sourcesPath = folders[record.type] + "/" + basename + ".sources.json";
        await this._mkdir(folder);
        if (sources) {
          await this._atomic(sourcesPath, JSON.stringify({ schemaVersion: 1, recordID: record.id,
            createdAt: record.createdAt, materials: sources }, null, 2) + "\n", "create");
        }
        // Card first, index second: an interrupted index update can leave a
        // recoverable card on disk, but cannot erase an existing card or index.
        await this._atomic(recordPath, this._recordMarkdown(record), "create");
        record.file = folders[record.type] + "/card-" + safeKey(record.id) + ".md";
        await this._atomic(indexPath, JSON.stringify({
          schemaVersion: 1, collection: this._collection(collection),
          updatedAt: new Date().toISOString(), records: [...records, record],
        }, null, 2) + "\n");
        return { directory, recordPath, indexPath,
          memoryPath: this.paths.join(directory, "memory.md"), sourcesPath, record };
      });
    }

    async saveSynthesis(collection, text, rootOverride = "") {
      if (typeof text !== "string" || !text.trim()) throw new Error("Memory synthesis must contain text");
      const directory = await this.directory(collection, rootOverride);
      return this._locked(directory, async () => {
        await this._mkdir(directory);
        const memoryPath = this.paths.join(directory, "memory.md");
        let backupPath = null;
        if (await this.io.exists(memoryPath)) {
          const oldMemory = await this.io.readUTF8(memoryPath);
          const backupDirectory = this.paths.join(directory, "backups");
          await this._mkdir(backupDirectory);
          backupPath = this.paths.join(backupDirectory, "memory-" + uniqueID() + ".md");
          // Do not replace the user's memory unless its exact backup succeeded.
          await this._atomic(backupPath, oldMemory, "create");
        }
        const scope = this._collection(collection);
        const content = "<!-- Research Companion; schemaVersion=1; updatedAt="
          + new Date().toISOString() + " -->\n"
          + "<!-- Collection: " + scalarLine(scope.libraryID + "/" + scope.key).replace(/-->/g, "") + " -->\n\n"
          + text.trim() + "\n";
        await this._atomic(memoryPath, content);
        return { directory, memoryPath, backupPath };
      });
    }

    async _conversation(directory, itemKey) {
      const path = this.paths.join(directory, "conversations", "item-" + safeKey(itemKey) + ".json");
      const data = await this._json(path);
      if (data === undefined) return { path, messages: [] };
      if (!data || data.schemaVersion !== 1 || data.itemKey !== string(itemKey)
        || !Array.isArray(data.messages) || !data.messages.every(validMessage)) {
        throw new Error("Unsupported or damaged conversation; original file was preserved: " + path);
      }
      return { path, messages: data.messages.slice(-40) };
    }

    async readConversation(collection, itemKey, rootOverride = "") {
      const directory = await this.directory(collection, rootOverride);
      return this._locked(directory, async () => (await this._conversation(directory, itemKey)).messages);
    }

    async saveConversation(collection, itemKey, messages, rootOverride = "") {
      if (!Array.isArray(messages) || !messages.every(validMessage)) {
        throw new Error("Conversation messages require a user/assistant role and string content");
      }
      const directory = await this.directory(collection, rootOverride);
      return this._locked(directory, async () => {
        // Read even when replacing, to avoid silently destroying a corrupt file.
        const { path } = await this._conversation(directory, itemKey);
        const saved = messages.slice(-40).map(message => ({ role: message.role, content: message.content }));
        await this._mkdir(this.paths.join(directory, "conversations"));
        await this._atomic(path, JSON.stringify({ schemaVersion: 1, itemKey: string(itemKey),
          updatedAt: new Date().toISOString(), messages: saved }, null, 2) + "\n");
        return { directory, path, messages: saved };
      });
    }

    async appendConversation(collection, itemKey, newMessages, rootOverride = "") {
      if (!Array.isArray(newMessages) || !newMessages.every(validMessage)) {
        throw new Error("Conversation messages require a user/assistant role and string content");
      }
      const directory = await this.directory(collection, rootOverride);
      return this._locked(directory, async () => {
        // Reading and appending must share one lock. A read-then-save in the UI
        // can overwrite a second reader window's already-completed conversation.
        const { path, messages } = await this._conversation(directory, itemKey);
        const saved = [...messages, ...newMessages].slice(-40)
          .map(message => ({ role: message.role, content: message.content }));
        await this._mkdir(this.paths.join(directory, "conversations"));
        await this._atomic(path, JSON.stringify({ schemaVersion: 1, itemKey: string(itemKey),
          updatedAt: new Date().toISOString(), messages: saved }, null, 2) + "\n");
        return { directory, path, messages: saved };
      });
    }

    async exportInventory(collection, items, rootOverride = "") {
      if (!Array.isArray(items)) throw new Error("An array of literature items is required");
      const directory = await this.directory(collection, rootOverride);
      return this._locked(directory, async () => {
        await this._mkdir(directory);
        const exportedItems = items.map(cleanInventoryItem);
        const scope = this._collection(collection);
        const jsonPath = this.paths.join(directory, "library.json");
        const markdownPath = this.paths.join(directory, "library.md");
        const updatedAt = new Date().toISOString();
        const lines = ["# " + scalarLine(scope.name) + "：文献目录", "",
          "更新时间：" + updatedAt, "", "本地路径仅用于本机定位附件。", ""];
        for (const item of exportedItems) {
          lines.push("## " + scalarLine(item.title || item.key || "未命名文献"), "",
            "- 引用：" + scalarLine(item.citation || (item.authors || []).join("; ") + " (" + (item.year || "n.d.") + ")"),
            "- DOI：" + scalarLine(item.doi), "- Zotero：" + scalarLine(item.zoteroURI));
          const paths = [...(item.localPaths || []), item.localPath,
            ...(item.attachments || []).map(attachment => attachment.path || attachment.localPath)].filter(Boolean);
          for (const path of new Set(paths)) lines.push("- 本地附件：" + scalarLine(path));
          lines.push("");
        }
        await this._atomic(jsonPath, JSON.stringify({ schemaVersion: 1, collection: scope,
          updatedAt, items: exportedItems }, null, 2) + "\n");
        await this._atomic(markdownPath, lines.join("\n"));
        return { directory, jsonPath, markdownPath };
      });
    }
  }

  root.RCMemory = RCMemory;
  if (typeof module !== "undefined" && module.exports) module.exports = RCMemory;
})(globalThis);
