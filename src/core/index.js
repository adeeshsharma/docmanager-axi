import Database from "better-sqlite3";
import { existsSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { docmanagerHome } from "./paths.js";
import { listFamilyIds, getFamily, readContent } from "./store.js";
import { extractTitle, extractPlainText } from "./html-normalize.js";

export function indexPath() {
  return join(docmanagerHome(), "index.db");
}

function buildSchema(db) {
  db.exec(`
    CREATE TABLE families (
      id TEXT PRIMARY KEY,
      synthetic_path TEXT NOT NULL,
      title TEXT,
      created_at TEXT,
      head_version TEXT,
      version_count INTEGER,
      tags_json TEXT,
      folder_id TEXT
    );
    CREATE TABLE versions (
      family_id TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at TEXT,
      source_file_name TEXT,
      supersedes TEXT,
      PRIMARY KEY (family_id, hash)
    );
    CREATE INDEX idx_versions_family ON versions(family_id);
    CREATE VIRTUAL TABLE search USING fts5(
      family_id UNINDEXED,
      synthetic_path,
      doc_title,
      body,
      tags,
      tokenize = 'porter unicode61'
    );
  `);
}

let dbHandle = null;

function closeHandle() {
  if (dbHandle) {
    dbHandle.close();
    dbHandle = null;
  }
}

// Exported for test cleanup only - real callers never need this directly,
// since rebuildIndex() already closes the cached handle itself before
// replacing the file. A test process that opened the index and then wants
// to delete the whole DOCMANAGER_HOME directory (most test cleanup) needs
// this explicitly: unlinking an open file is silently fine on POSIX but a
// hard EBUSY on Windows, since the cached handle is a module-level
// singleton that otherwise stays open for the rest of that test file's
// process - confirmed for real on windows-latest CI, invisible on POSIX.
export function closeIndexHandle() {
  closeHandle();
}

/**
 * Rebuilds the local SQLite index from the store's JSON metadata (the
 * synced source of truth). Writes to a temp file and renames it into place,
 * so a concurrent query never sees a half-written database - and closes any
 * cached handle first, since an already-open handle keeps reading the old
 * file's inode after a rename, not the new content at that path.
 */
export function rebuildIndex() {
  closeHandle();

  const tmpPath = `${indexPath()}.tmp-${process.pid}-${Date.now()}`;
  if (existsSync(tmpPath)) unlinkSync(tmpPath);

  const db = new Database(tmpPath);
  try {
    buildSchema(db);
    const insertFamily = db.prepare(
      "INSERT INTO families (id, synthetic_path, title, created_at, head_version, version_count, tags_json, folder_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const insertVersion = db.prepare(
      "INSERT INTO versions (family_id, hash, created_at, source_file_name, supersedes) VALUES (?, ?, ?, ?, ?)",
    );
    const insertSearch = db.prepare(
      "INSERT INTO search (family_id, synthetic_path, doc_title, body, tags) VALUES (?, ?, ?, ?, ?)",
    );

    const insertAll = db.transaction((ids) => {
      for (const id of ids) {
        // A single corrupt family JSON file must never take down the index
        // for every OTHER, perfectly healthy family - getFamily() throws on
        // invalid JSON with no try/catch of its own (see doctor.js's own
        // familyIntegrity check for surfacing that specific problem to the
        // user); this just makes sure it can't cascade into breaking
        // `docmanager families`/`status` for everything else too.
        let family;
        try {
          family = getFamily(id);
        } catch {
          continue;
        }
        if (!family) continue;
        const tags = family.tags ?? [];
        const versionEntries = Object.entries(family.versions);
        insertFamily.run(
          family.id,
          family.syntheticPath,
          family.title ?? null,
          family.createdAt,
          family.headVersion,
          versionEntries.length,
          JSON.stringify(tags),
          family.folderId ?? null,
        );
        for (const [hash, v] of versionEntries) {
          insertVersion.run(family.id, hash, v.createdAt, v.sourceFileName ?? null, v.supersedes ?? null);
        }

        // Indexed for search from the HEAD version only - "where's the
        // document about X" means current state, not every historical
        // draft. A missing content blob (see doctor.js's contentIntegrity
        // check) or content malformed enough that parse5 chokes still
        // leaves the family searchable by its synthetic path.
        const content = readContent(family.headVersion);
        let docTitle = null;
        let body = "";
        if (content) {
          try {
            docTitle = extractTitle(content);
            body = extractPlainText(content);
          } catch {
            // fall through with docTitle/body left empty
          }
        }
        insertSearch.run(family.id, family.syntheticPath, docTitle, body, tags.join(" "));
      }
    });
    insertAll(listFamilyIds());
  } finally {
    db.close();
  }

  renameSync(tmpPath, indexPath());
}

function openIndex() {
  if (!dbHandle) {
    if (!existsSync(indexPath())) {
      rebuildIndex();
    }
    dbHandle = new Database(indexPath(), { readonly: false });
  }
  return dbHandle;
}

export function listFamiliesFromIndex() {
  const db = openIndex();
  return db
    .prepare(
      "SELECT id, synthetic_path as syntheticPath, title, created_at as createdAt, head_version as headVersion, version_count as versionCount, tags_json as tagsJson, folder_id as folderId FROM families ORDER BY created_at DESC",
    )
    .all()
    .map(({ tagsJson, ...rest }) => ({ ...rest, tags: tagsJson ? JSON.parse(tagsJson) : [] }));
}

// Each raw word becomes a quoted, prefix-matched FTS5 term ("report"* etc.),
// joined with FTS5's default implicit AND. Quoting is what keeps this safe
// against FTS5's own query-syntax characters (unmatched quotes, hyphens as
// NOT, colons as column filters) in arbitrary user input - a raw pass-through
// would let a search for e.g. "Q3-report" throw a MATCH syntax error instead
// of just searching for it.
function toFtsQuery(query) {
  return query
    .trim()
    .split(/\s+/)
    .filter((term) => term.length > 0)
    .map((term) => `"${term.replace(/"/g, '""')}"*`)
    .join(" ");
}

const SEARCH_RESULT_LIMIT = 20;

/**
 * Basic keyword search over tracked documents' synthetic paths, extracted
 * titles, and visible text (HEAD version only) - explicitly not semantic/RAG
 * search, which stays a deferred phase-2 goal (ARCHITECTURE.md). Cheap
 * enough to answer "where's the document about X" without waiting on
 * embeddings, since the index is already rebuilt from the same source data
 * on every relevant change.
 */
export function searchFamilies(query) {
  const ftsQuery = toFtsQuery(query);
  if (!ftsQuery) return [];

  const db = openIndex();
  return db
    .prepare(
      `SELECT f.id as id, f.synthetic_path as syntheticPath, f.version_count as versionCount,
              f.head_version as headVersion, s.doc_title as docTitle,
              snippet(search, 3, '**', '**', '…', 12) as snippet
       FROM search s
       JOIN families f ON f.id = s.family_id
       WHERE search MATCH ?
       ORDER BY bm25(search)
       LIMIT ${SEARCH_RESULT_LIMIT}`,
    )
    .all(ftsQuery);
}

export function getFamilyFromIndex(id) {
  const db = openIndex();
  const row = db
    .prepare(
      "SELECT id, synthetic_path as syntheticPath, title, created_at as createdAt, head_version as headVersion, tags_json as tagsJson, folder_id as folderId FROM families WHERE id = ?",
    )
    .get(id);
  if (!row) return null;
  const { tagsJson, ...family } = row;
  family.tags = tagsJson ? JSON.parse(tagsJson) : [];
  const versions = db
    .prepare(
      "SELECT hash, created_at as createdAt, source_file_name as sourceFileName, supersedes FROM versions WHERE family_id = ? ORDER BY created_at ASC",
    )
    .all(id)
    .map((v) => ({ ...v, current: v.hash === family.headVersion }));
  return { ...family, versions };
}
