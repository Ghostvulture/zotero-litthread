"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const RCData = require("../modules/data.js");

function fixture() {
  const items = new Map();
  const files = new Map();
  const indexed = [];
  const collections = new Map();
  const fulltext = {
    INDEX_STATE_PARTIAL: 2, INDEX_STATE_INDEXED: 3,
    getItemCacheFile: item => ({ path: `/cache/${item.key}` }),
    getIndexedState: async item => item.indexState || 3,
    indexItems: async (ids, options) => { indexed.push({ ids, options }); }
  };
  const Zotero = {
    Libraries: { userLibraryID: 1 },
    Items: {
      getAsync: async ids => Array.isArray(ids) ? ids.map(id => items.get(id)) : items.get(ids),
      getAll: async (libraryID, topLevel, includeDeleted) => {
        assert.equal(topLevel, true); assert.equal(includeDeleted, false);
        return [...items.values()].filter(item => item.libraryID === libraryID && !item.parentID);
      }
    },
    Collections: {
      get: id => collections.get(id), getAsync: async id => collections.get(id),
      getByLibrary: (libraryID, recursive, includeTrashed) => {
        assert.equal(recursive, true); assert.equal(includeTrashed, false);
        return [...collections.values()].filter(c => c.libraryID === libraryID);
      }
    },
    URI: { getItemURI: item => `http://zotero.org/users/local/test/items/${item.key}` },
    Fulltext: fulltext
  };
  const IOUtils = {
    exists: async path => files.has(path),
    readUTF8: async path => { if (!files.has(path)) throw new Error("Not found"); return files.get(path); }
  };
  const addItem = (id, type = "regular", overrides = {}) => {
    const item = {
      id, key: `KEY${id}`, libraryID: 1, deleted: false, parentID: false,
      isAttachment: () => type === "attachment", isRegularItem: () => type === "regular",
      isAnnotation: () => type === "annotation", isFileAttachment: () => type === "attachment",
      loadAllData: async () => {}, getCreators: () => [{ firstName: "Ada", lastName: "Lovelace" }],
      getField: name => ({ title: `Paper ${id}`, date: "2024-04", DOI: "10.123/a", abstractNote: "An abstract" })[name] || "",
      getTags: () => [{ tag: "robotics" }], getAttachments: () => [], getBestAttachment: async () => null,
      getFilePathAsync: async () => false, getAnnotations: () => [], ...overrides
    };
    items.set(id, item); return item;
  };
  return { data: new RCData({ Zotero, IOUtils }), addItem, items, files, collections, fulltext, indexed };
}

test("collections retain nested display paths; item lists contain direct regular members only", async () => {
  const f = fixture();
  const paper = f.addItem(1), childPaper = f.addItem(2);
  const note = f.addItem(3, "note"), attachment = f.addItem(4, "attachment");
  const trashed = f.addItem(5, "regular", { deleted: true });
  f.collections.set(10, { id: 10, key: "COLROOT", name: "Robotics", libraryID: 1, parentID: false,
    getChildItems: () => [paper, note, attachment, trashed] });
  f.collections.set(11, { id: 11, key: "COLCHILD", name: "VLA", libraryID: 1, parentID: 10,
    getChildItems: () => [childPaper] });
  f.collections.set(12, { id: 12, key: "DELETED", name: "Old", libraryID: 1, deleted: true });
  assert.deepEqual((await f.data.listCollections()).map(c => c.path), ["Robotics", "Robotics / VLA"]);
  assert.deepEqual((await f.data.listItems(10)).map(item => item.id), [1]);
  assert.equal(await f.data.getCollection(12), null);
  assert.deepEqual((await f.data.listItems()).map(item => item.id), [1, 2]);
  await assert.rejects(f.data.listItems(10, 99), /分组不属于/);
});

test("metadata is based on the reader attachment's actual parent and preserves source URI", async () => {
  const f = fixture();
  const parent = f.addItem(1);
  const currentAttachment = f.addItem(2, "attachment", { parentID: 1 });
  const unrelated = f.addItem(3, "attachment");
  parent.getBestAttachment = async () => unrelated;
  const resolved = await f.data.resolveItem(2);
  assert.equal(resolved.item, currentAttachment);
  assert.equal(resolved.parent, parent);
  assert.equal(resolved.attachment, currentAttachment);
  const metadata = await f.data.metadata(currentAttachment);
  assert.deepEqual(metadata.authors, ["Ada Lovelace"]);
  assert.equal(metadata.year, "2024");
  assert.equal(metadata.id, 1);
  assert.equal(metadata.zoteroURI, "http://zotero.org/users/local/test/items/KEY1");
});

test("native Windows, Linux and macOS paths are returned without separator rewriting", async () => {
  const f = fixture();
  const paths = ["C:\\Users\\Z\\Zotero\\storage\\KEY2\\paper.pdf", "/home/z/Zotero/storage/KEY3/paper.pdf", "/Users/z/Zotero/storage/KEY4/paper.pdf"];
  const parent = f.addItem(1, "regular", { getAttachments: () => [2, 3, 4, 5] });
  paths.forEach((path, i) => {
    f.files.set(path, "%PDF-binary");
    f.addItem(i + 2, "attachment", { getFilePathAsync: async () => path, attachmentContentType: "application/pdf" });
  });
  f.addItem(5, "attachment", { getFilePath: () => "/missing/paper.pdf" });
  const records = await f.data.attachments(parent);
  assert.deepEqual(records.slice(0, 3).map(record => record.path), paths);
  assert.ok(records.slice(0, 3).every(record => record.exists));
  assert.deepEqual([records[3].path, records[3].exists], ["/missing/paper.pdf", false]);
});

test("PDF cache text is used, bounded, and never fabricated into page references", async () => {
  const f = fixture();
  const attachment = f.addItem(2, "attachment", { attachmentContentType: "application/pdf", getFilePathAsync: async () => "/paper.pdf" });
  f.files.set("/cache/KEY2", "Verified source paragraph");
  f.files.set("/paper.pdf", "%PDF-binary");
  const result = await f.data.readText(attachment, { maxChars: 8 });
  assert.equal(result.text, "Verified");
  assert.equal(result.source, "zotero-cache");
  assert.equal(result.attachmentID, 2);
  assert.equal(result.truncated, true);
  assert.match(result.warning, /页码/);
  assert.equal(f.indexed.length, 0);
});

test("a partial PDF cache triggers complete local indexing, then reads the renewed cache", async () => {
  const f = fixture();
  const attachment = f.addItem(2, "attachment", { indexState: 2, attachmentContentType: "application/pdf", getFilePathAsync: async () => "/paper.pdf" });
  f.files.set("/cache/KEY2", "Partial");
  f.fulltext.indexItems = async (ids, options) => {
    f.indexed.push({ ids, options }); attachment.indexState = 3;
    f.files.set("/cache/KEY2", "Complete body with the missing conclusion");
  };
  const result = await f.data.readText(attachment);
  assert.equal(result.text, "Complete body with the missing conclusion");
  assert.deepEqual(f.indexed, [{ ids: [2], options: { complete: true, ignoreErrors: true } }]);
  assert.doesNotMatch(result.warning, /仍显示不完整/);
});

test("scanned PDFs produce an OCR limitation and PDF binary never enters the prompt", async () => {
  const f = fixture();
  const attachment = f.addItem(2, "attachment", { attachmentContentType: "application/pdf", getFilePathAsync: async () => "/scanned.pdf", attachmentText: "" });
  f.files.set("/scanned.pdf", "%PDF-1.7\u0000binary data");
  const result = await f.data.readText(attachment);
  assert.equal(result.text, ""); assert.equal(result.source, "none");
  assert.match(result.warning, /OCR/);
  assert.equal(f.indexed.length, 1);
  assert.equal(f.data._cleanText("%PDF-1.7 misleading text"), "");
});

test("plain text is readable, unsupported binary attachments are not decoded", async () => {
  const f = fixture();
  const text = f.addItem(2, "attachment", { attachmentContentType: "text/plain", getFilePathAsync: async () => "/notes.txt" });
  f.files.set("/notes.txt", "A grounded paragraph\r\n第二段");
  assert.equal((await f.data.readText(text)).text, "A grounded paragraph\n第二段");
  const binary = f.addItem(3, "attachment", { attachmentContentType: "application/msword", getFilePathAsync: async () => "/document.doc" });
  f.files.set("/document.doc", "This must never be read as plaintext");
  assert.equal((await f.data.readText(binary)).text, "");
});

test("missing local attachment can use its cached text with an explicit warning", async () => {
  const f = fixture();
  const attachment = f.addItem(2, "attachment", { attachmentContentType: "application/pdf" });
  f.files.set("/cache/KEY2", "Previously extracted source text");
  const result = await f.data.readText(attachment);
  assert.equal(result.source, "zotero-cache"); assert.match(result.warning, /原始附件当前不在本地/);
  assert.equal(f.indexed.length, 0);
  f.files.clear();
  assert.match((await f.data.readText(attachment)).warning, /尚未下载/);
});

test("annotations preserve actual page labels and exclude deleted annotations", async () => {
  const f = fixture();
  const annotation = f.addItem(3, "annotation", { parentID: 2, annotationText: "A source quote", annotationComment: "Compare methods", annotationPageLabel: "iv" });
  const deleted = f.addItem(4, "annotation", { deleted: true, annotationText: "Do not include" });
  const attachment = f.addItem(2, "attachment", { getAnnotations: () => [annotation, deleted] });
  const annotations = await f.data.annotations(attachment);
  assert.deepEqual(annotations, [{ text: "A source quote", comment: "Compare methods", pageLabel: "iv", key: "KEY3" }]);
  assert.equal((await f.data.resolveItem(annotation)).attachment, attachment);
  await assert.rejects(f.data.readText(attachment, { maxChars: 0 }), /maxChars/);
});

test("stable FullText APIs support extraction without legacy fulltext tables or processor helpers", async () => {
  // Verified against Zotero's 10.0.7 source: these extraction/cache APIs remain
  // stable although the search index moved to FTS5 and processor helpers changed.
  const f = fixture();
  const zotero = f.data.Zotero;
  zotero.FullText = zotero.Fulltext;
  delete zotero.Fulltext;
  Object.defineProperty(zotero, "DB", { get() { throw new Error("The adapter must not access version-specific index tables"); } });
  Object.defineProperty(zotero.FullText, "getItemProcessorCacheFile", {
    get() { throw new Error("Zotero 10 renamed this internal processor helper"); }
  });
  const attachment = f.addItem(7, "attachment", {
    indexState: 2, attachmentContentType: "application/pdf",
    getFilePathAsync: async () => "C:\\Research\\paper.pdf"
  });
  f.files.set("/cache/KEY7", "Old partial cache");
  zotero.FullText.indexItems = async (ids, options) => {
    assert.deepEqual(ids, [7]);
    assert.deepEqual(options, { complete: true, ignoreErrors: true });
    f.files.set("/cache/KEY7", "Full text extracted through the supported Zotero 10 cache API");
    attachment.indexState = 3;
  };
  const result = await f.data.readText(attachment, { maxChars: 18 });
  assert.equal(result.source, "zotero-cache");
  assert.equal(result.text, "Full text extracte");
  assert.equal(result.attachmentKey, "KEY7");
  assert.equal(result.truncated, true);
  assert.doesNotMatch(result.warning, /索引未能完成|仍显示不完整/);
});

test("PDF extraction degrades to attachmentText when index APIs are absent", async () => {
  const f = fixture();
  delete f.data.Zotero.Fulltext;
  f.data.Zotero.FullText = {};
  const attachment = f.addItem(8, "attachment", {
    attachmentContentType: "application/pdf", getFilePathAsync: async () => "/papers/reader.pdf",
    attachmentText: Promise.resolve("Actual PDF text from Zotero's item API")
  });
  const result = await f.data.readText(attachment);
  assert.equal(result.source, "zotero-text");
  assert.equal(result.text, "Actual PDF text from Zotero's item API");
  assert.equal(result.attachmentID, 8);
  assert.match(result.warning, /页码/);
  assert.equal(f.indexed.length, 0);
});
