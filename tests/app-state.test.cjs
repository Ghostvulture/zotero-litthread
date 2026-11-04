"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { View } = require("../modules/app.js");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function node() {
  return { children: [], value: "", textContent: "", disabled: false, dataset: {},
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = [...children]; this.textContent = ""; } };
}
function fixture() {
  const parent = { id: 1, key: "PAPER1", libraryID: 1, getCollections: () => [10], isAttachment: () => false };
  const otherParent = { id: 2, key: "PAPER2", libraryID: 1, getCollections: () => [], isAttachment: () => false };
  const main = { id: 101, key: "MAINPDF", libraryID: 1, parentID: 1, isAttachment: () => true };
  const supplement = { id: 102, key: "SUPPPDF", libraryID: 1, parentID: 1, isAttachment: () => true };
  const otherAttachment = { id: 103, key: "OTHERPDF", libraryID: 1, parentID: 2, isAttachment: () => true };
  const items = new Map([parent, otherParent, main, supplement, otherAttachment].map(item => [item.id, item]));
  const groups = [
    { id: 10, key: "GROUPA", libraryID: 1, name: "Group A", path: "Group A" },
    { id: 20, key: "GROUPB", libraryID: 1, name: "Group B", path: "Group B" }
  ];
  const readers = new Map([["tab-main", { itemID: 101 }], ["tab-supp", { itemID: 102 }], ["tab-other", { itemID: 103 }]]);
  const details = { tabID: "tab-main" };
  const calls = [];
  const app = {
    active: true, selections: new Map(), rootFor: () => "",
    Zotero: {
      Reader: { getByTabID: id => readers.get(id) },
      Items: { getAsync: async id => items.get(id), get: id => items.get(id) },
      getActiveZoteroPane: () => ({ getSelectedCollection: () => null })
    },
    data: {
      resolveItem: async item => {
        calls.push(item?.id);
        return item ? { item, parent: items.get(item.parentID) || null, attachment: item.isAttachment() ? item : main }
          : { item: null, parent: null, attachment: null };
      },
      metadata: async item => ({ id: item.id, key: item.key, libraryID: item.libraryID, title: item.key }),
      listCollections: async () => groups,
      listItems: async () => [parent, otherParent].map(item => ({ id: item.id, key: item.key, title: item.key })),
      attachments: async () => []
    },
    memory: {
      read: async collection => ({ directory: "/memory/" + collection.key, memory: "", records: [] }),
      readConversation: async (collection, key) => [{ role: "user", content: collection.key + ":" + key }]
    }
  };
  const view = Object.create(View.prototype);
  Object.assign(view, { app, doc: { defaultView: {} }, body: { closest: () => details }, epoch: 0,
    history: [{ role: "user", content: "stale" }], loading: false, bound: true, busy: false,
    item: parent, meta: { id: 1, key: "OLDMETA" }, saved: { memory: "old" }, attachment: main,
    collection: groups[0], collections: groups, collectionItems: [{ key: "OLD" }],
    el: (_tag, text) => Object.assign(node(), { textContent: text || "" }),
    button: (text, action) => Object.assign(node(), { textContent: text, action }),
    renderHistory() { this.renderedHistory = [...this.history]; }
  });
  for (const key of ["chat", "question", "sendButton", "cancelButton", "title", "selectionBox", "collectionSelect", "filesBox", "itemsBox", "memoryPath", "collectionInfo", "statusBox"]) view[key] = node();
  return { view, app, parent, otherParent, main, supplement, otherAttachment, items, groups, readers, details, calls };
}

test("binding disables sending and clears stale metadata before the reader item lookup resolves", async () => {
  const f = fixture(), lookup = deferred();
  f.app.Zotero.Items.getAsync = () => lookup.promise;
  const pending = f.view.bind({ item: f.parent, tabType: "reader" });
  assert.equal(f.view.loading, true); assert.equal(f.view.sendButton.disabled, true);
  for (const field of ["item", "meta", "attachment", "collection", "saved"]) assert.equal(f.view[field], null, field);
  assert.deepEqual(f.view.collectionItems, []);
  lookup.resolve(f.main); await pending;
  assert.equal(f.view.attachment, f.main); assert.equal(f.view.meta.key, "PAPER1");
  assert.equal(f.view.loading, false); assert.equal(f.view.sendButton.disabled, true);
});

test("an older asynchronous reader lookup cannot replace a newer tab's article", async () => {
  const f = fixture(), oldLookup = deferred();
  f.app.Zotero.Items.getAsync = id => id === 101 ? oldLookup.promise : Promise.resolve(f.items.get(id));
  const oldBind = f.view.bind({ item: f.parent, tabType: "reader" });
  f.details.tabID = "tab-other";
  await f.view.bind({ item: f.otherParent, tabType: "reader" });
  oldLookup.resolve(f.main); await oldBind;
  assert.equal(f.view.item, f.otherParent); assert.equal(f.view.attachment, f.otherAttachment);
  assert.equal(f.view.meta.key, "PAPER2");
  assert.deepEqual(f.calls, [103]);
});

test("different PDF tabs for the same parent retain the exact attachment", async () => {
  const f = fixture();
  await f.view.bind({ item: f.parent, tabType: "reader" });
  assert.equal(f.view.attachment, f.main);
  f.details.tabID = "tab-supp";
  await f.view.bind({ item: f.parent, tabType: "reader" });
  assert.equal(f.view.attachment, f.supplement);
  assert.deepEqual(f.calls, [101, 102]);
});

test("an unavailable reader never falls back to the parent item's preferred PDF", async () => {
  const f = fixture(); f.readers.clear();
  await f.view.bind({ item: f.parent, tabType: "reader" });
  assert.equal(f.view.item, null); assert.equal(f.view.attachment, null);
  assert.equal(f.view.sendButton.disabled, true); assert.deepEqual(f.calls, []);
  assert.match(f.view.statusBox.textContent, /尚未确定当前阅读的附件/);
  f.view.doc.defaultView.Zotero_Tabs = { _getTab: id => id === "tab-main" ? { tab: { data: { itemID: 102 } } } : null };
  await f.view.bind({ item: f.parent, tabType: "reader" });
  assert.equal(f.view.attachment, f.supplement);
});

test("a separate reader window resolves its own reader rather than the main-window selection", async () => {
  const f = fixture(); f.details.tabID = undefined;
  f.view.doc.defaultView.reader = { itemID: 102 };
  await f.view.bind({ item: f.parent, tabType: "reader" });
  assert.equal(f.view.attachment, f.supplement);
});

test("changing groups removes old memory and inventory until the new group finishes loading", async () => {
  const f = fixture(), listing = deferred(); f.view.collectionSelect.value = "20";
  f.app.data.listItems = () => listing.promise;
  const pending = f.view.changeCollection();
  assert.equal(f.view.loading, true); assert.equal(f.view.sendButton.disabled, true);
  assert.equal(f.view.saved, null); assert.deepEqual(f.view.history, []); assert.deepEqual(f.view.collectionItems, []);
  listing.resolve([]); await pending;
  assert.equal(f.view.collection.key, "GROUPB"); assert.equal(f.view.saved.directory, "/memory/GROUPB");
  assert.equal(f.view.loading, false); assert.equal(f.view.sendButton.disabled, true);
});

test("late results from a previous group cannot overwrite the active group", async () => {
  const f = fixture(), listing = deferred();
  f.app.data.listItems = id => id === 10 ? listing.promise : Promise.resolve([]);
  f.view.collectionSelect.value = "10";
  const oldChange = f.view.changeCollection();
  f.view.collectionSelect.value = "20";
  await f.view.changeCollection();
  listing.resolve([{ id: 1, key: "STALE", title: "Old group paper" }]); await oldChange;
  assert.equal(f.view.collection.key, "GROUPB"); assert.equal(f.view.saved.directory, "/memory/GROUPB");
  assert.deepEqual(f.view.collectionItems, []);
});

test("virtual unfiled scope filters out items in real collections", async () => {
  const f = fixture(); f.view.collectionSelect.value = "";
  await f.view.changeCollection();
  assert.equal(f.view.collection.id, null); assert.equal(f.view.collection.key, "unfiled");
  assert.deepEqual(f.view.collectionItems.map(item => item.id), [2]);
});

test("empty and deleted items cannot retain a previously readable article", async () => {
  const f = fixture();
  await f.view.bind({ item: null, tabType: "library" });
  assert.equal(f.view.item, null); assert.equal(f.view.saved, null); assert.equal(f.view.sendButton.disabled, true);
  f.app.data.resolveItem = async () => ({ item: null, parent: null, attachment: null });
  await f.view.bind({ item: f.parent, tabType: "library" });
  assert.equal(f.view.item, null); assert.equal(f.view.meta, null); assert.equal(f.view.sendButton.disabled, true);
  assert.match(f.view.title.textContent, /不可用/);
});

test("Zotero 10 plural selection avoids the throwing legacy getter", async () => {
  const f = fixture();
  f.view.doc.defaultView.ZoteroPane = {
    getSelectedCollections: () => [{ id: 20 }, { id: 10 }],
    getSelectedCollection: () => { throw new Error("Use getSelectedCollections"); }
  };
  await f.view.bind({ item: f.parent, tabType: "library" });
  assert.equal(f.view.collection.id, 10);
  assert.equal(f.view.loading, false);
});

test("Zotero 10 empty selection falls back to paper membership", async () => {
  const f = fixture();
  f.view.doc.defaultView.ZoteroPane = { getSelectedCollections: () => [] };
  await f.view.bind({ item: f.parent, tabType: "library" });
  assert.equal(f.view.collection.id, 10);
});

test("Zotero 7 singular selection still chooses the selected containing group", async () => {
  const f = fixture();
  f.parent.getCollections = () => [10, 20];
  f.view.doc.defaultView.ZoteroPane = { getSelectedCollection: () => ({ id: 20 }) };
  await f.view.bind({ item: f.parent, tabType: "library" });
  assert.equal(f.view.collection.id, 20);
});

function settingsFixture() {
  let config = { baseURL: "https://api.example.org", model: "model-a" };
  let choices = ["model-a", "model-b"];
  const view = Object.create(View.prototype);
  view.app = { config: () => config, modelChoices: () => choices };
  view.baseURL = Object.assign(node(), { value: config.baseURL });
  view.model = Object.assign(node(), { value: config.model });
  view.models = Object.assign(node(), { value: choices.join("\n") });
  view.settingsSnapshot = { ...config, models: choices.join("\n") };
  return { view, change() { config = { baseURL: "https://new.example.org", model: "model-c" }; choices = ["model-c", "model-d"]; } };
}

test("an unchanged settings page follows connection changes from another reader tab", () => {
  const f = settingsFixture(); f.change(); f.view.refreshSettings();
  assert.equal(f.view.baseURL.value, "https://new.example.org");
  assert.equal(f.view.model.value, "model-c");
  assert.equal(f.view.models.value, "model-c\nmodel-d");
});

test("refreshing another tab's saved settings preserves deliberate local unsaved edits", () => {
  const f = settingsFixture();
  f.view.baseURL.value = "https://draft.example.org";
  f.view.model.value = "draft-model";
  f.view.models.value = "draft-model\ncustom-model";
  f.change(); f.view.refreshSettings(); f.view.refreshSettings();
  assert.equal(f.view.baseURL.value, "https://draft.example.org");
  assert.equal(f.view.model.value, "draft-model");
  assert.equal(f.view.models.value, "draft-model\ncustom-model");
});

test("an article switch while credentials are loading cannot send the old question for the new article", async () => {
  const f = fixture(), key = deferred();
  f.view.mode = { value: "chat" }; f.view.question.value = "Question about old article";
  f.app.config = () => ({ baseURL: "https://api.example.org", model: "model-a" });
  f.app.key = () => key.promise;
  let reads = 0; f.app.data.readText = async () => { reads++; return { text: "wrong article" }; };
  const pending = f.view.send();
  await f.view.bind({ item: f.otherParent, tabType: "library" });
  key.resolve("test-key"); await pending;
  assert.equal(reads, 0); assert.equal(f.view.item, f.otherParent);
  assert.equal(f.view.busy, false);
});

test("ordinary comparison reads fresh selected collection peers, bounds work and tolerates missing PDFs", async () => {
  const f = fixture(); const reads = [];
  f.view.controller = new AbortController();
  f.app.data.listItems = async (id, libraryID) => {
    assert.equal(id, 10); assert.equal(libraryID, 1);
    return [f.parent, ...Array.from({ length: 9 }, (_, i) => ({ id: i + 2, key: 'PEER' + i, title: i === 8 ? 'VLA methods' : 'Paper' }))];
  };
  f.app.data.readText = async id => { reads.push(id); if (id === 2) throw new Error('missing'); return { text: 'Peer evidence' }; };
  const context = await f.view.collectionContext('和文件夹中的其他 VLA 相关文献对照', 'chat', f.view.collection, f.parent, f.view.epoch);
  assert.equal(context.items.length, 10); assert.equal(reads.length, 6);
  assert.equal(reads[0], 10); assert.ok(!reads.includes(1));
  assert.equal(context.peers.filter(p => p.text).length, 5);
  assert.match(context.coverage, /5\/9/);
});

test("collection retrieval stops after cancellation or article switch", async () => {
  const f = fixture(), gate = deferred(); let count = 0;
  f.view.controller = new AbortController();
  f.app.data.readText = async () => { count++; return gate.promise; };
  const pending = f.view.collectionContext('对照其他文献', 'chat', f.view.collection, f.parent, f.view.epoch);
  await new Promise(resolve => setImmediate(resolve));
  f.view.controller.abort(); gate.resolve({ text: 'late' });
  assert.equal(await pending, null); assert.equal(count, 1);
});

test("ordinary paragraph questions include the catalog without reading other PDFs", async () => {
  const f = fixture(); f.app.data.readText = () => { throw new Error('unexpected read'); };
  const context = await f.view.collectionContext('解释这段公式', 'chat', f.view.collection, f.parent, f.view.epoch);
  assert.equal(context.items.length, 2); assert.equal(context.peers.length, 0);
});

test("unfiled context excludes filed papers and never scans their text", async () => {
  const f = fixture(); const read = [];
  f.app.data.readText = async id => { read.push(id); return { text: 'unfiled' }; };
  const context = await f.view.collectionContext('对照其他', 'chat', { id: null, key: 'unfiled', libraryID: 1, name: '未分组' }, f.otherParent, f.view.epoch);
  assert.deepEqual(context.items.map(item => item.id), [2]);
  assert.deepEqual(read, []);
});
