/* Research Companion: Zotero 7 local library adapter, with no external runtime dependencies. */
(function (root) {
  "use strict";

  class RCData {
    constructor({ Zotero, IOUtils, PathUtils } = {}) {
      if (!Zotero) throw new Error("RCData requires Zotero");
      this.Zotero = Zotero;
      this.IOUtils = IOUtils;
      this.PathUtils = PathUtils;
      this._indexing = new Map();
    }

    async _item(value) {
      if (value && typeof value === "object") return value;
      if (value == null || value === "") return null;
      return await this.Zotero.Items.getAsync(Number(value)) || null;
    }

    async _loaded(object) {
      if (object && typeof object.loadAllData === "function") await object.loadAllData();
      return object;
    }

    async getCollection(id) {
      if (id == null || id === "") return null;
      const collections = this.Zotero.Collections;
      const collection = typeof collections.getAsync === "function"
        ? await collections.getAsync(Number(id)) : collections.get(Number(id));
      if (!collection || collection.deleted) return null;
      return this._loaded(collection);
    }

    async listCollections(libraryID = this.Zotero.Libraries.userLibraryID) {
      const collections = await this.Zotero.Collections.getByLibrary(libraryID, true, false);
      const byID = new Map(collections.map(collection => [collection.id, collection]));
      return collections.filter(collection => !collection.deleted).map(collection => {
        const names = [String(collection.name || "")];
        const visited = new Set([collection.id]);
        let parentID = collection.parentID;
        while (parentID && !visited.has(parentID)) {
          visited.add(parentID);
          const parent = byID.get(parentID) || this.Zotero.Collections.get(parentID);
          if (!parent || parent.libraryID !== collection.libraryID) break;
          names.unshift(String(parent.name || ""));
          parentID = parent.parentID;
        }
        return {
          id: collection.id, key: collection.key, libraryID: collection.libraryID,
          name: String(collection.name || ""), path: names.join(" / ")
        };
      });
    }

    async listItems(collectionID = null, libraryID = this.Zotero.Libraries.userLibraryID) {
      let items;
      if (collectionID !== null && collectionID !== undefined && collectionID !== "") {
        const collection = await this.getCollection(collectionID);
        if (!collection) return [];
        if (libraryID != null && collection.libraryID !== Number(libraryID)) {
          throw new Error("分组不属于指定的文献库。");
        }
        items = await collection.getChildItems(false, false);
      } else {
        items = await this.Zotero.Items.getAll(libraryID, true, false);
      }
      const records = [];
      for (const entry of items) {
        const item = await this._item(entry);
        if (!item || item.deleted || !item.isRegularItem()) continue;
        records.push(await this.metadata(item));
      }
      return records;
    }

    /** Never consults the library selection: the caller supplies the reader's item. */
    async resolveItem(itemOrID) {
      const item = await this._loaded(await this._item(itemOrID));
      if (!item || item.deleted) return { item: null, parent: null, attachment: null };
      let attachment = item.isAttachment() ? item : null;
      let parent = null;
      if (typeof item.isAnnotation === "function" && item.isAnnotation() && item.parentID) {
        attachment = await this._loaded(await this._item(item.parentID));
        if (attachment && !attachment.isAttachment()) attachment = null;
      }
      const parentID = attachment ? attachment.parentID : item.parentID;
      if (parentID) parent = await this._loaded(await this._item(parentID));
      if (parent && (parent.deleted || !parent.isRegularItem())) parent = null;
      if (!attachment) {
        const regular = item.isRegularItem() ? item : parent;
        if (regular && typeof regular.getBestAttachment === "function") {
          attachment = await regular.getBestAttachment() || null;
          await this._loaded(attachment);
        }
      }
      if (attachment && attachment.deleted) attachment = null;
      return { item, parent, attachment };
    }

    async metadata(itemOrID) {
      let item = await this._loaded(await this._item(itemOrID));
      if (!item) return null;
      if (!item.isRegularItem()) {
        const resolved = await this.resolveItem(item);
        item = resolved.parent || item;
      }
      const field = name => {
        try { return String(item.getField(name) || ""); } catch (_) { return ""; }
      };
      const title = field("title");
      const creators = typeof item.getCreators === "function" ? item.getCreators() : [];
      const authors = creators.map(creator =>
        creator.name || [creator.firstName, creator.lastName].filter(Boolean).join(" ")
      ).filter(Boolean);
      const yearMatch = field("date").match(/\b[12]\d{3}\b/);
      const year = yearMatch ? yearMatch[0] : "";
      const tags = typeof item.getTags === "function"
        ? item.getTags().map(tag => typeof tag === "string" ? tag : tag.tag).filter(Boolean) : [];
      let zoteroURI = "";
      if (this.Zotero.URI && typeof this.Zotero.URI.getItemURI === "function") {
        zoteroURI = this.Zotero.URI.getItemURI(item);
      }
      return {
        id: item.id, key: item.key, libraryID: item.libraryID, title, authors, year,
        doi: field("DOI"), abstract: field("abstractNote"), tags,
        citation: [authors.join(", "), year ? `(${year})` : "", title].filter(Boolean).join(" "),
        zoteroURI
      };
    }

    async attachments(itemOrID) {
      const resolved = await this.resolveItem(itemOrID);
      if (!resolved.item) return [];
      const regular = resolved.item.isRegularItem() ? resolved.item : resolved.parent;
      let items;
      if (resolved.item.isAttachment()) items = [resolved.item];
      else if (regular) items = await this.Zotero.Items.getAsync(regular.getAttachments(false));
      else items = resolved.attachment ? [resolved.attachment] : [];
      const records = [];
      for (const attachment of items) {
        if (!attachment || attachment.deleted || !attachment.isAttachment()) continue;
        const localPath = await attachment.getFilePathAsync();
        // A missing file can still have a useful expected path. Never expand storage: ourselves.
        let path = localPath || null;
        if (!path && typeof attachment.getFilePath === "function") {
          try { path = attachment.getFilePath() || null; } catch (_) { /* Invalid legacy path. */ }
        }
        const exists = !!localPath && (!this.IOUtils || !this.IOUtils.exists
          || await this.IOUtils.exists(localPath));
        records.push({
          id: attachment.id, key: attachment.key, title: attachment.getField("title") || "",
          path, exists: !!exists, contentType: attachment.attachmentContentType || ""
        });
      }
      return records;
    }

    async annotations(itemOrID) {
      const { attachment } = await this.resolveItem(itemOrID);
      if (!attachment || typeof attachment.getAnnotations !== "function") return [];
      if (typeof attachment.isFileAttachment === "function" && !attachment.isFileAttachment()) return [];
      const result = [];
      for (const annotation of await attachment.getAnnotations(false)) {
        if (!annotation || annotation.deleted) continue;
        await this._loaded(annotation);
        result.push({
          text: String(annotation.annotationText || ""), comment: String(annotation.annotationComment || ""),
          pageLabel: String(annotation.annotationPageLabel || ""), key: annotation.key
        });
      }
      return result;
    }

    async _readUTF8(path) {
      if (this.IOUtils && typeof this.IOUtils.readUTF8 === "function") return this.IOUtils.readUTF8(path);
      if (this.Zotero.File && typeof this.Zotero.File.getContentsAsync === "function") {
        return this.Zotero.File.getContentsAsync(path, "UTF-8");
      }
      throw new Error("当前 Zotero 环境不支持读取本地文本。");
    }

    async _cacheText(attachment) {
      const fulltext = this.Zotero.Fulltext || this.Zotero.FullText;
      if (!fulltext || typeof fulltext.getItemCacheFile !== "function") return "";
      try {
        const file = fulltext.getItemCacheFile(attachment);
        const path = typeof file === "string" ? file : file.path;
        if (this.IOUtils && this.IOUtils.exists && !await this.IOUtils.exists(path)) return "";
        if ((!this.IOUtils || !this.IOUtils.exists) && typeof file.exists === "function" && !file.exists()) return "";
        return this._cleanText(await this._readUTF8(path));
      } catch (_) { return ""; }
    }

    _cleanText(text) {
      if (typeof text !== "string") return "";
      // Text caches and falsely labelled plaintext must not become binary prompt content.
      if (/^\s*(?:%PDF-|PK\u0003\u0004)/.test(text) || text.includes("\u0000")) return "";
      return text.replace(/\r\n?/g, "\n").trim();
    }

    async readText(itemOrAttachment, { maxChars = 120000 } = {}) {
      if (!Number.isFinite(maxChars) || maxChars < 1) throw new Error("maxChars 必须是正数。");
      maxChars = Math.floor(maxChars);
      const { attachment } = await this.resolveItem(itemOrAttachment);
      const result = { text: "", source: "none", attachmentID: attachment ? attachment.id : null,
        attachmentKey: attachment ? attachment.key : null, truncated: false, warning: "" };
      if (!attachment) {
        result.warning = "这条文献没有可读取的本地附件。请先添加或下载 PDF。";
        return result;
      }
      const fulltext = this.Zotero.Fulltext || this.Zotero.FullText;
      let text = await this._cacheText(attachment);
      let source = text ? "zotero-cache" : "none";
      let partial = false;
      let path = null;
      const warnings = [];
      try { path = await attachment.getFilePathAsync(); } catch (_) { /* Cache may still be available. */ }
      if (fulltext && typeof fulltext.getIndexedState === "function") {
        try {
          partial = await fulltext.getIndexedState(attachment) === fulltext.INDEX_STATE_PARTIAL;
        } catch (_) { /* Do not block reading an existing cache. */ }
      }
      let contentType = attachment.attachmentContentType || "";
      if (!contentType && path && this.Zotero.MIME && this.Zotero.MIME.getMIMETypeFromFile) {
        try { contentType = await this.Zotero.MIME.getMIMETypeFromFile(path); } catch (_) { /* Unknown is unsupported. */ }
      }
      const convertible = ["application/pdf", "application/epub+zip", "text/html", "application/xhtml+xml"].includes(contentType);
      if ((!text || partial) && path && convertible && fulltext && typeof fulltext.indexItems === "function") {
        try {
          let task = this._indexing.get(attachment.id);
          if (!task) {
            task = Promise.resolve(fulltext.indexItems([attachment.id], { complete: true, ignoreErrors: true }));
            this._indexing.set(attachment.id, task);
          }
          try { await task; } finally { if (this._indexing.get(attachment.id) === task) this._indexing.delete(attachment.id); }
          const indexedText = await this._cacheText(attachment);
          if (indexedText) { text = indexedText; source = "zotero-cache"; }
          if (typeof fulltext.getIndexedState === "function") {
            partial = await fulltext.getIndexedState(attachment) === fulltext.INDEX_STATE_PARTIAL;
          }
        } catch (_) { warnings.push("Zotero 本地全文索引未能完成。"); }
      }
      if ((!text || partial) && path && ["application/pdf", "text/html", "text/plain"].includes(contentType)) {
        try {
          const extracted = this._cleanText(await attachment.attachmentText);
          if (extracted && (!text || extracted.length >= text.length)) {
            text = extracted; source = "zotero-text";
            // attachmentText can perform an independent full PDF extraction; its completeness is not asserted.
          }
        } catch (_) { warnings.push("Zotero 附件文本提取失败。"); }
      }
      if (!text && path && ["text/plain", "text/markdown", "text/x-markdown", "text/csv"].includes(contentType)) {
        try { text = this._cleanText(await this._readUTF8(path)); source = text ? "local-text" : "none"; }
        catch (_) { warnings.push("本地文本附件无法读取。"); }
      }
      if (!text) {
        warnings.push(!path
          ? "附件尚未下载、已移动或本地路径不可用；请在 Zotero 中打开或重新定位附件。"
          : contentType === "application/pdf"
            ? "PDF 没有提取到可用文字；可能是扫描件、受保护文件或索引被禁用。扫描件需要先做 OCR，本插件不执行 OCR。"
            : "此附件尚无可用的全文文本；当前支持 Zotero 可索引的 PDF、EPUB、HTML 和纯文本。");
      }
      if (partial && text) warnings.push("Zotero 全文索引仍显示不完整，部分段落可能不可用。");
      if (text && !path) warnings.push("原始附件当前不在本地；以下内容来自 Zotero 已缓存的文本。");
      const truncated = text.length > maxChars;
      if (truncated) warnings.push(`正文超过 ${maxChars} 字符，当前只读取前部；可选择目标段落提问。`);
      if (text && contentType === "application/pdf") warnings.push("提取正文不包含可靠的页码映射；仅批注自带的页码可作为页码依据。");
      return { ...result, text: text.slice(0, maxChars), source: text ? source : "none",
        truncated, warning: warnings.join(" ") };
    }
  }

  root.RCData = RCData;
  if (typeof module !== "undefined" && module.exports) module.exports = RCData;
})(typeof globalThis !== "undefined" ? globalThis : this);
