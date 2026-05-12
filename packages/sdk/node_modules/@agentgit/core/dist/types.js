/**
 * AgentGit Core Data Model
 *
 * Content-Addressing Algorithm:
 *   Objects are identified by the SHA-256 hash of their canonical JSON representation.
 *   Canonical JSON: keys sorted lexicographically at every level, no extra whitespace,
 *   UTF-8 encoded. The "type" field is always included and sorted first only by natural
 *   alphabetical order (no special treatment). To compute a hash:
 *     1. Construct the object as a plain JS value (omitting the `hash` field itself).
 *     2. JSON.stringify with a key-sorting replacer.
 *     3. SHA-256 the resulting UTF-8 bytes.
 *     4. Hex-encode the digest → 64-character lowercase string.
 *   This guarantees identical content always produces the same address regardless of
 *   insertion order, matching git's content-addressed object model.
 *
 * Directory layout (.agentgit/):
 *   HEAD          — plain text; "ref: refs/sessions/<sessionId>" or a bare commit hash
 *   refs/         — subdirectory; each file is a ref name containing a commit hash
 *   objects/      — content-addressed object files; sharded as objects/<2-char prefix>/<62-char suffix>
 *   index.db      — SQLite metadata index (see schema.sql)
 */
export {};
//# sourceMappingURL=types.js.map