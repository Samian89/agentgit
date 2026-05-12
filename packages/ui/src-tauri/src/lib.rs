use std::collections::HashMap;

use serde::Serialize;
use sqlx::{Row, SqlitePool};

// ---------------------------------------------------------------------------
// Row types returned from IPC commands
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct SessionRow {
    id: String,
    name: String,
    status: String,
    head: Option<String>,
    created_at: i64,
    updated_at: i64,
    metadata: String,
}

#[derive(Serialize)]
pub struct CommitRow {
    hash: String,
    tree: String,
    parent: Option<String>,
    session_id: String,
    timestamp: i64,
    message: String,
    tool_call: Option<String>,
    metadata: String,
}

#[derive(Serialize)]
pub struct DiffEntry {
    path: String,
    from_hash: Option<String>,
    to_hash: Option<String>,
}

#[derive(Serialize)]
pub struct DiffResult {
    hash1: String,
    hash2: String,
    commit1_tool_call: Option<String>,
    commit2_tool_call: Option<String>,
    added: Vec<DiffEntry>,
    removed: Vec<DiffEntry>,
    modified: Vec<DiffEntry>,
}

#[derive(Serialize)]
pub struct BlameEntry {
    path: String,
    commit_hash: String,
    timestamp: i64,
    message: String,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async fn open_pool(db_path: &str) -> Result<SqlitePool, String> {
    SqlitePool::connect(&format!("sqlite:{}", db_path))
        .await
        .map_err(|e| e.to_string())
}

async fn fetch_tree_entries(
    pool: &SqlitePool,
    tree_hash: &str,
) -> Result<HashMap<String, String>, String> {
    let rows = sqlx::query("SELECT path, blob_hash FROM tree_entries WHERE tree_hash = ?")
        .bind(tree_hash)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|r| (r.get::<String, _>("path"), r.get::<String, _>("blob_hash")))
        .collect())
}

// ---------------------------------------------------------------------------
// Tauri IPC commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn get_sessions(db_path: String) -> Result<Vec<SessionRow>, String> {
    let pool = open_pool(&db_path).await?;
    let rows = sqlx::query(
        "SELECT id, name, status, head, created_at, updated_at, metadata \
         FROM sessions ORDER BY created_at DESC",
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows
        .into_iter()
        .map(|r| SessionRow {
            id: r.get("id"),
            name: r.get("name"),
            status: r.get("status"),
            head: r.get("head"),
            created_at: r.get("created_at"),
            updated_at: r.get("updated_at"),
            metadata: r.get("metadata"),
        })
        .collect())
}

#[tauri::command]
async fn get_commits(db_path: String, session_id: String) -> Result<Vec<CommitRow>, String> {
    let pool = open_pool(&db_path).await?;
    let rows = sqlx::query(
        "SELECT hash, tree, parent, session_id, timestamp, message, tool_call, metadata \
         FROM commits WHERE session_id = ? ORDER BY timestamp ASC",
    )
    .bind(&session_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows
        .into_iter()
        .map(|r| CommitRow {
            hash: r.get("hash"),
            tree: r.get("tree"),
            parent: r.get("parent"),
            session_id: r.get("session_id"),
            timestamp: r.get("timestamp"),
            message: r.get("message"),
            tool_call: r.get("tool_call"),
            metadata: r.get("metadata"),
        })
        .collect())
}

#[tauri::command]
async fn get_diff(
    db_path: String,
    hash1: String,
    hash2: String,
) -> Result<DiffResult, String> {
    let pool = open_pool(&db_path).await?;

    let rows = sqlx::query(
        "SELECT hash, tree, tool_call FROM commits WHERE hash = ? OR hash = ?",
    )
    .bind(&hash1)
    .bind(&hash2)
    .fetch_all(&pool)
    .await
    .map_err(|e| e.to_string())?;

    let find = |h: &str| {
        rows.iter()
            .find(|r| r.get::<String, _>("hash") == h)
            .map(|r| {
                (
                    r.get::<String, _>("tree"),
                    r.get::<Option<String>, _>("tool_call"),
                )
            })
            .ok_or_else(|| format!("commit not found: {h}"))
    };

    let (tree1, tc1) = find(&hash1)?;
    let (tree2, tc2) = find(&hash2)?;

    let entries1 = fetch_tree_entries(&pool, &tree1).await?;
    let entries2 = fetch_tree_entries(&pool, &tree2).await?;

    let mut added = Vec::new();
    let mut removed = Vec::new();
    let mut modified = Vec::new();

    for (path, to_hash) in &entries2 {
        match entries1.get(path) {
            None => added.push(DiffEntry {
                path: path.clone(),
                from_hash: None,
                to_hash: Some(to_hash.clone()),
            }),
            Some(from_hash) if from_hash != to_hash => modified.push(DiffEntry {
                path: path.clone(),
                from_hash: Some(from_hash.clone()),
                to_hash: Some(to_hash.clone()),
            }),
            _ => {}
        }
    }
    for (path, from_hash) in &entries1 {
        if !entries2.contains_key(path) {
            removed.push(DiffEntry {
                path: path.clone(),
                from_hash: Some(from_hash.clone()),
                to_hash: None,
            });
        }
    }

    Ok(DiffResult {
        hash1,
        hash2,
        commit1_tool_call: tc1,
        commit2_tool_call: tc2,
        added,
        removed,
        modified,
    })
}

#[tauri::command]
async fn get_blame(db_path: String, session_id: String) -> Result<Vec<BlameEntry>, String> {
    let pool = open_pool(&db_path).await?;

    let rows = sqlx::query(
        "SELECT hash, tree, timestamp, message \
         FROM commits WHERE session_id = ? ORDER BY timestamp ASC",
    )
    .bind(&session_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| e.to_string())?;

    let mut blame: HashMap<String, BlameEntry> = HashMap::new();
    let mut prev: HashMap<String, String> = HashMap::new();

    for row in &rows {
        let hash: String = row.get("hash");
        let tree: String = row.get("tree");
        let timestamp: i64 = row.get("timestamp");
        let message: String = row.get("message");

        let entries = fetch_tree_entries(&pool, &tree).await?;
        let current_paths: std::collections::HashSet<&String> = entries.keys().collect();

        for (path, blob_hash) in &entries {
            if prev.get(path) != Some(blob_hash) {
                blame.insert(
                    path.clone(),
                    BlameEntry {
                        path: path.clone(),
                        commit_hash: hash.clone(),
                        timestamp,
                        message: message.clone(),
                    },
                );
            }
        }
        prev.retain(|p, _| current_paths.contains(p));
        for (path, blob_hash) in entries {
            prev.insert(path, blob_hash);
        }
    }

    let mut result: Vec<BlameEntry> = blame.into_values().collect();
    result.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(result)
}

// ---------------------------------------------------------------------------
// App entry point
// ---------------------------------------------------------------------------

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_sessions,
            get_commits,
            get_diff,
            get_blame
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
