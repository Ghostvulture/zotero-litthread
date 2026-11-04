"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const RCMemory = require("../modules/memory.js");

function mockStore(platform = "posix") {
  const paths = path[platform];
  const files = new Map();
  const directories = new Set();
  const writes = [];
  let failure = null;
  const io = {
    async exists(file) { return files.has(file) || directories.has(file); },
    async readUTF8(file) {
      if (!files.has(file)) throw new Error("ENOENT: " + file);
      return files.get(file);
    },
    async makeDirectory(directory, options) {
      assert.equal(options.createAncestors, true);
      assert.equal(options.ignoreExisting, true);
      directories.add(directory);
    },
    async writeUTF8(file, content, options) {
      // Yield so concurrent updates really overlap unless storage serializes them.
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(typeof content, "string");
      assert.ok(options.tmpPath.startsWith(file + ".tmp-"));
      assert.equal(options.flush, true);
      if (failure && failure(file)) throw new Error("simulated disk failure");
      if (options.mode === "create" && files.has(file)) throw new Error("EEXIST");
      writes.push({ file, content, options });
      files.set(file, content);
    },
  };
  const dependencies = { IOUtils: io, PathUtils: paths,
    Zotero: { DataDirectory: { dir: platform === "win32" ? "C:\\Users\\Researcher\\Zotero" : "/home/researcher/Zotero" },
      Libraries: { userLibraryID: 1 } } };
  return { files, writes, directories, paths, dependencies,
    store: new RCMemory(dependencies), fail: callback => { failure = callback; } };
}

const groupA = { key: "ABCD1234", libraryID: 1, name: "VLA / RL" };
const groupB = { key: "EFGH5678", libraryID: 1, name: "VLA / RL" };
const item = { key: "PAPER001", title: "A research paper", authors: ["Ada Lovelace"], year: "2026",
  doi: "10.1234/paper", citation: "Lovelace (2026)", zoteroURI: "zotero://select/library/items/PAPER001", libraryID: 1 };
const record = { type: "claim-card", item, content: "A claim supported by section 3.",
  question: "What is the central claim?", selection: "Original paragraph\nSecond line", tags: ["topic:VLA", "method:RL"] };

test("collection keys isolate same-name groups and survive renaming", async () => {
  const { store } = mockStore();
  const first = await store.directory(groupA);
  assert.equal(first, "/home/researcher/Zotero/research-companion/library-1/collection-ABCD1234");
  assert.notEqual(first, await store.directory(groupB));
  assert.equal(first, await store.directory({ ...groupA, name: "Renamed" }));
  assert.notEqual(first, await store.directory({ ...groupA, libraryID: 2 }));
  assert.equal(await store.directory(null), "/home/researcher/Zotero/research-companion/library-1/unfiled");
  assert.equal(await store.directory(groupA, "/research/pdfs"), "/research/pdfs/library-1/collection-ABCD1234");
  await store.saveRecord(groupA, record);
  assert.equal((await store.read(groupA)).records.length, 1);
  assert.deepEqual((await store.read(groupB)).records, []);
});

test("Windows and POSIX paths use the supplied PathUtils implementation", async () => {
  const { store, files } = mockStore("win32");
  const result = await store.saveRecord(groupA, record, "D:\\Papers");
  assert.equal(result.directory, "D:\\Papers\\library-1\\collection-ABCD1234");
  assert.ok(files.has(result.recordPath));
  assert.match(result.recordPath, /\\claims\\card-[^\\]+\.md$/);
});

test("keys and record IDs cannot traverse directories or collide through sanitization", async () => {
  const { store, paths } = mockStore();
  const dangerous = { ...groupA, key: "../../outside\\secret" };
  const directory = await store.directory(dangerous, "/safe");
  assert.equal(paths.dirname(directory), "/safe/library-1");
  assert.ok(!paths.basename(directory).includes(".."));
  assert.notEqual(await store.directory({ ...groupA, key: "a/b" }),
    await store.directory({ ...groupA, key: "a%00002fb" }));
  const saved = await store.saveRecord(groupA, { ...record, id: "../../evil" });
  assert.equal(paths.dirname(saved.recordPath), paths.join(saved.directory, "claims"));
  const conversation = await store.saveConversation(groupA, "../CON\\file", []);
  assert.equal(paths.dirname(conversation.path), paths.join(conversation.directory, "conversations"));
});

test("concurrent writes across store instances preserve all records", async () => {
  const mock = mockStore();
  const secondStore = new RCMemory(mock.dependencies);
  await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? mock.store : secondStore)
    .saveRecord(groupA, { ...record, id: "record-" + i, content: "Claim " + i })));
  const result = await mock.store.read(groupA);
  assert.equal(result.records.length, 20);
  assert.equal(new Set(result.records.map(value => value.id)).size, 20);
  for (const saved of result.records) {
    const cardPath = mock.paths.join(result.directory, ...saved.file.split("/"));
    assert.match(mock.files.get(cardPath), new RegExp(saved.content));
  }
});

test("records produce dedicated Markdown with source metadata and leave memory untouched", async () => {
  const { store, files } = mockStore();
  const synthesis = await store.saveSynthesis(groupA, "# Human-reviewed knowledge map\nOriginal notes");
  const previous = files.get(synthesis.memoryPath);
  for (const [type, folder] of [["literature-note", "notes"], ["claim-card", "claims"],
    ["evidence-card", "evidence"], ["conversation", "conversations"]]) {
    const saved = await store.saveRecord(groupA, { ...record, type });
    assert.ok(saved.recordPath.includes("/" + folder + "/"));
    const markdown = files.get(saved.recordPath);
    assert.match(markdown, /10\.1234\/paper/);
    assert.match(markdown, /zotero:\/\/select\/library\/items\/PAPER001/);
    assert.match(markdown, /> Original paragraph\n> Second line/);
    assert.equal(saved.record.content, record.content);
  }
  assert.equal(files.get(synthesis.memoryPath), previous);
});

test("malformed and unsupported indexes are preserved without creating cards", async () => {
  for (const corrupted of ["{oops", "null", "[]", '{"schemaVersion":2,"records":[]}',
    '{"schemaVersion":1,"records":[{"id":"broken"}]}']) {
    const { store, files, writes } = mockStore();
    const index = path.posix.join(await store.directory(groupA), "records.json");
    files.set(index, corrupted);
    await assert.rejects(store.saveRecord(groupA, record), /preserved/);
    await assert.rejects(store.read(groupA), /preserved/);
    assert.equal(files.get(index), corrupted);
    assert.equal(writes.length, 0);
  }
});

test("duplicate IDs never overwrite existing cards or index", async () => {
  const { store, files } = mockStore();
  const saved = await store.saveRecord(groupA, { ...record, id: "fixed-id" });
  const snapshot = new Map(files);
  await assert.rejects(store.saveRecord(groupA, { ...record, id: "fixed-id", content: "changed" }), /already exists/);
  assert.deepEqual(files, snapshot);
  assert.equal((await store.read(groupA)).records[0].id, saved.record.id);
});

test("synthesis keeps exact backups of earlier memory and does not overwrite on backup failure", async () => {
  const { store, files, fail } = mockStore();
  const first = await store.saveSynthesis(groupA, "# First map");
  assert.equal(first.backupPath, null);
  const original = files.get(first.memoryPath);
  const second = await store.saveSynthesis(groupA, "# Second map");
  assert.equal(files.get(second.backupPath), original);
  assert.match(files.get(second.memoryPath), /updatedAt=\d{4}-/);
  const beforeFailure = files.get(second.memoryPath);
  fail(file => file.includes("/backups/"));
  await assert.rejects(store.saveSynthesis(groupA, "# Third map"), /disk failure/);
  assert.equal(files.get(second.memoryPath), beforeFailure);
  fail(null);
  const third = await store.saveSynthesis(groupA, "# Third map");
  assert.notEqual(third.backupPath, second.backupPath);
  assert.equal(files.get(third.backupPath), beforeFailure);
});

test("an index write failure keeps old index and a recoverable card; later updates still work", async () => {
  const { store, files, fail } = mockStore();
  const first = await store.saveRecord(groupA, { ...record, id: "first" });
  const original = files.get(first.indexPath);
  fail(file => file.endsWith("records.json"));
  await assert.rejects(store.saveRecord(groupA, { ...record, id: "interrupted" }), /disk failure/);
  assert.equal(files.get(first.indexPath), original);
  assert.ok(files.has(path.posix.join(first.directory, "claims", "card-interrupted.md")));
  fail(null);
  await store.saveRecord(groupA, { ...record, id: "after-failure" });
  assert.equal((await store.read(groupA)).records.length, 2);
});

test("persistent conversations isolate both collection and paper and cap at 40 messages", async () => {
  const { store, files } = mockStore();
  const messages = Array.from({ length: 45 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "Message " + i }));
  const saved = await store.saveConversation(groupA, item.key, messages);
  assert.equal(saved.messages.length, 40);
  assert.equal(saved.messages[0].content, "Message 5");
  assert.deepEqual(await store.readConversation(groupA, item.key), saved.messages);
  assert.deepEqual(await store.readConversation(groupB, item.key), []);
  assert.deepEqual(await store.readConversation(groupA, "OTHER001"), []);
  const original = files.get(saved.path);
  await assert.rejects(store.saveConversation(groupA, item.key, [{ role: "system", content: "Forbidden runtime state" }]));
  assert.equal(files.get(saved.path), original);
});

test("corrupted conversations are not overwritten", async () => {
  for (const corrupted of ["{oops", "null", '{"schemaVersion":1,"itemKey":"wrong","messages":[]}']) {
    const { store, files } = mockStore();
    const saved = await store.saveConversation(groupA, item.key, []);
    files.set(saved.path, corrupted);
    await assert.rejects(store.saveConversation(groupA, item.key, [{ role: "user", content: "new" }]), /preserved/);
    await assert.rejects(store.appendConversation(groupA, item.key, [{ role: "user", content: "new" }]), /preserved/);
    assert.equal(files.get(saved.path), corrupted);
  }
});

test("atomic conversation append preserves concurrent reader pairs and caps merged history", async () => {
  const mock = mockStore();
  const secondStore = new RCMemory(mock.dependencies);
  await mock.store.saveConversation(groupA, item.key, [{ role: "user", content: "old message" }]);
  await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? mock.store : secondStore)
    .appendConversation(groupA, item.key, [
      { role: "user", content: "question-" + i }, { role: "assistant", content: "answer-" + i },
    ])));
  const history = await mock.store.readConversation(groupA, item.key);
  assert.equal(history.length, 40);
  assert.equal(new Set(history.map(message => message.content)).size, 40);
  assert.ok(!history.some(message => message.content === "old message"));
  for (let i = 0; i < 20; i++) {
    const at = history.findIndex(message => message.content === "question-" + i);
    assert.notEqual(at, -1);
    assert.equal(history[at + 1].content, "answer-" + i);
  }
  const beforeInvalid = await mock.store.readConversation(groupA, item.key);
  await assert.rejects(mock.store.appendConversation(groupA, item.key, [{ role: "system", content: "invalid" }]));
  assert.deepEqual(await mock.store.readConversation(groupA, item.key), beforeInvalid);
});

test("card sidecars preserve request-local evidence and whitelist packet contents", async () => {
  const { store, files } = mockStore();
  const sources = {
    scope: "Finite request-local evidence",
    apiKey: "unrelated-runtime-credential",
    localPath: "/private/file.pdf",
    current_item: { source_id: "I1", bibliographic_metadata: {
      title: item.title, year: item.year, doi: item.doi,
      path: "/private/metadata.pdf", apiKey: "another-secret-value",
    } },
    selected_text: { source_id: "S1", text: "Selected evidence", path: "/private/selection.pdf" },
    fulltext_status: "Only excerpts included",
    excerpts: [{ source_id: "F001", text: "Exact research claim with numerical result 42." },
      { source_id: "F017", text: "Path /home/me/secret.pdf and sk-example12345\nAPI Key: my-hidden-value" }],
    annotations: { source_id: "A1", text: "Personal annotation", status: "Unverified" },
    memory: { source_id: "M1", text: "Memory interpretation", status: "Unverified" },
    collection_items: [{ source_id: "C1", metadata: { title: "Other paper", doi: "10.1000/other", localPath: "/secret/other.pdf" } }],
    collection_scope: "1/1 metadata entries",
    previous_conversation: [{ role: "user", content: "Earlier research question" }],
  };
  const saved = await store.saveRecord(groupA, { ...record, id: "with-sources", sources });
  assert.equal(saved.sourcesPath, path.posix.join(saved.directory, "claims", "card-with-sources.sources.json"));
  const sidecar = files.get(saved.sourcesPath);
  const packet = JSON.parse(sidecar);
  assert.equal(packet.schemaVersion, 1);
  assert.equal(packet.recordID, "with-sources");
  assert.equal(packet.materials.excerpts[0].source_id, "F001");
  assert.equal(packet.materials.excerpts[0].text, sources.excerpts[0].text);
  assert.equal(packet.materials.collection_items[0].metadata.doi, "10.1000/other");
  for (const sensitive of ["unrelated-runtime-credential", "another-secret-value", "/private/", "/home/me/", "/secret/", "sk-example12345", "my-hidden-value"]) {
    assert.ok(!sidecar.includes(sensitive), sensitive + " leaked into source packet");
  }
  assert.match(files.get(saved.recordPath), /\[查看本次材料包\]\(\.\/card-with-sources\.sources\.json\)/);
  const index = JSON.parse(files.get(saved.indexPath));
  assert.equal(index.records[0].sourcesPath, "claims/card-with-sources.sources.json");
  assert.ok(!files.get(saved.indexPath).includes("Exact research claim with numerical result 42."));
  assert.ok(!("sources" in index.records[0]));
});

test("local inventory exports include attachment locations but strip unrelated secret fields", async () => {
  const { store, files } = mockStore();
  const saved = await store.exportInventory(groupA, [{ ...item, apiKey: "sk-never-save",
    config: { token: "runtime-secret" }, localPaths: ["/papers/article.pdf"],
    attachments: [{ key: "PDF001", path: "C:\\Papers\\article.pdf", exists: true, token: "attachment-secret" }] }]);
  const json = files.get(saved.jsonPath);
  assert.ok(!json.includes("secret"));
  assert.ok(!json.includes("sk-never-save"));
  const data = JSON.parse(json);
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.items[0].attachments[0].path, "C:\\Papers\\article.pdf");
  assert.match(files.get(saved.markdownPath), /\/papers\/article\.pdf/);
  assert.match(files.get(saved.markdownPath), /10\.1234\/paper/);
});
