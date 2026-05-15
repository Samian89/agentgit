use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};
use uuid::Uuid;

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
    llm_call: Option<String>,
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
        "SELECT hash, tree, parent, session_id, timestamp, message, tool_call, llm_call, metadata \
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
            llm_call: r.get("llm_call"),
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
// Remote management IPC (spec 005)
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
pub struct RemoteRecord {
    pub name: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

#[derive(Serialize)]
pub struct PushSessionResult {
    pub ok: bool,
    pub remote: String,
    pub session_id: String,
    pub share_url: String,
    pub output: String,
}

fn agentgit_dir_from_db_path(db_path: &str) -> PathBuf {
    let p = Path::new(db_path);
    p.parent().map(|d| d.to_path_buf()).unwrap_or_else(|| PathBuf::from("."))
}

fn config_path(agentgit_dir: &Path) -> PathBuf {
    agentgit_dir.join("config.json")
}

fn read_config_file(agentgit_dir: &Path) -> Result<Value, String> {
    let path = config_path(agentgit_dir);
    if !path.exists() {
        return Ok(Value::Object(Map::new()));
    }
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if text.trim().is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

fn write_config_file(agentgit_dir: &Path, value: &Value) -> Result<(), String> {
    let path = config_path(agentgit_dir);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    fs::write(&path, text + "\n").map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Canonical JSON + SHA-256 (must match packages/core/src/hash.ts for bundle
// compatibility and object store). Used for synthetic replay commits.
// ---------------------------------------------------------------------------

fn strip_non_content_fields(v: &Value) -> Value {
    if let Value::Object(map) = v {
        let mut out = Map::new();
        for (k, val) in map {
            if k != "hash" && k != "signature" && k != "publicKey" {
                out.insert(k.clone(), strip_non_content_fields(val));
            }
        }
        Value::Object(out)
    } else if let Value::Array(arr) = v {
        Value::Array(arr.iter().map(strip_non_content_fields).collect())
    } else {
        v.clone()
    }
}

fn canonical_json(v: &Value) -> String {
    match v {
        Value::Object(map) => {
            let mut entries: Vec<(String, String)> = map
                .iter()
                .map(|(k, val)| (k.clone(), canonical_json(val)))
                .collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            let body = entries
                .into_iter()
                .map(|(k, j)| format!("\"{}\":{}", k, j))
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{}}}", body)
        }
        Value::Array(arr) => {
            let items: Vec<String> = arr.iter().map(canonical_json).collect();
            format!("[{}]", items.join(","))
        }
        Value::String(s) => serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into()),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => if *b { "true".into() } else { "false".into() },
        Value::Null => "null".into(),
    }
}

fn sha256_hex(v: &Value) -> String {
    let stripped = strip_non_content_fields(v);
    let json = canonical_json(&stripped);
    let mut hasher = Sha256::new();
    hasher.update(json.as_bytes());
    let digest = hasher.finalize();
    digest.iter().map(|b| format!("{:02x}", b)).collect()
}

fn agentgit_objects_dir(db_path: &str) -> PathBuf {
    let dir = agentgit_dir_from_db_path(db_path);
    dir.join("objects")
}

fn write_object_file(objects_dir: &Path, hash: &str, body: &Value) -> Result<(), String> {
    if hash.len() < 64 {
        return Err("invalid hash length".into());
    }
    let prefix = &hash[0..2];
    let suffix = &hash[2..];
    let subdir = objects_dir.join(prefix);
    fs::create_dir_all(&subdir).map_err(|e| e.to_string())?;
    let path = subdir.join(suffix);
    let json = canonical_json(body);
    fs::write(&path, json).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// New write-side IPC commands (AMC-f3602678)
// ---------------------------------------------------------------------------

#[tauri::command]
async fn create_session(
    db_path: String,
    name: String,
    metadata: Value,
) -> Result<SessionRow, String> {
    let pool = open_pool(&db_path).await?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as i64;
    let id = Uuid::new_v4().to_string();
    let meta_str = if metadata.is_null() || metadata.as_object().map(|m| m.is_empty()).unwrap_or(false) {
        "{}".to_string()
    } else {
        serde_json::to_string(&metadata).map_err(|e| e.to_string())?
    };

    sqlx::query(
        "INSERT INTO sessions (id, name, status, head, created_at, updated_at, metadata) \
         VALUES (?, ?, 'active', NULL, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&name)
    .bind(now)
    .bind(now)
    .bind(&meta_str)
    .execute(&pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(SessionRow {
        id,
        name,
        status: "active".into(),
        head: None,
        created_at: now,
        updated_at: now,
        metadata: meta_str,
    })
}

#[tauri::command]
async fn replay_from_commit(
    db_path: String,
    commit_hash: String,
    new_session_name: String,
) -> Result<SessionRow, String> {
    let pool = open_pool(&db_path).await?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as i64;

    // Fetch source commit's tree (and optionally its metadata for copy)
    let src = sqlx::query(
        "SELECT tree, message, metadata FROM commits WHERE hash = ? LIMIT 1",
    )
    .bind(&commit_hash)
    .fetch_optional(&pool)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| format!("source commit not found: {}", commit_hash))?;

    let tree: String = src.get("tree");
    let _src_message: String = src.get("message");
    let _src_meta: String = src.get("metadata");

    // Build new session
    let new_session_id = Uuid::new_v4().to_string();
    let session_meta = json!({ "replayedFrom": commit_hash }).to_string();

    sqlx::query(
        "INSERT INTO sessions (id, name, status, head, created_at, updated_at, metadata) \
         VALUES (?, ?, 'active', NULL, ?, ?, ?)",
    )
    .bind(&new_session_id)
    .bind(&new_session_name)
    .bind(now)
    .bind(now)
    .bind(&session_meta)
    .execute(&pool)
    .await
    .map_err(|e| e.to_string())?;

    // Build synthetic initial commit body (no toolCall, parent null, metadata with replayedFrom)
    let mut commit_body = Map::new();
    commit_body.insert("type".to_string(), Value::String("commit".into()));
    commit_body.insert("tree".to_string(), Value::String(tree.clone()));
    commit_body.insert("parent".to_string(), Value::Null);
    commit_body.insert("sessionId".to_string(), Value::String(new_session_id.clone()));
    commit_body.insert("timestamp".to_string(), Value::Number(now.into()));
    commit_body.insert(
        "message".to_string(),
        Value::String(format!("Replay from {}", &commit_hash[..8.min(commit_hash.len())])),
    );
    commit_body.insert("toolCall".to_string(), Value::Null);
    let mut meta = Map::new();
    meta.insert("replayedFrom".to_string(), Value::String(commit_hash.clone()));
    commit_body.insert("metadata".to_string(), Value::Object(meta));
    commit_body.insert("author".to_string(), Value::Null);

    let body_value = Value::Object(commit_body);
    let new_commit_hash = sha256_hex(&body_value);

    // Write the commit object file (reuses existing tree/blobs, no new writes for them)
    let objects_dir = agentgit_objects_dir(&db_path);
    write_object_file(&objects_dir, &new_commit_hash, &body_value)?;

    // Insert the commit row + update session head (no tx for simplicity, desktop use)
    let commit_meta = json!({ "replayedFrom": commit_hash }).to_string();
    sqlx::query(
        "INSERT INTO commits (hash, tree, parent, session_id, timestamp, message, tool_call, metadata) \
         VALUES (?, ?, NULL, ?, ?, ?, NULL, ?)",
    )
    .bind(&new_commit_hash)
    .bind(&tree)
    .bind(&new_session_id)
    .bind(now)
    .bind("Replay from here")
    .bind(&commit_meta)
    .execute(&pool)
    .await
    .map_err(|e| e.to_string())?;

    sqlx::query(
        "UPDATE sessions SET head = ?, updated_at = ? WHERE id = ?",
    )
    .bind(&new_commit_hash)
    .bind(now)
    .bind(&new_session_id)
    .execute(&pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(SessionRow {
        id: new_session_id,
        name: new_session_name,
        status: "active".into(),
        head: Some(new_commit_hash),
        created_at: now,
        updated_at: now,
        metadata: session_meta,
    })
}

#[tauri::command]
async fn export_bundle(
    db_path: String,
    session_id: String,
    out_path: String,
) -> Result<Value, String> {
    let dir = agentgit_dir_from_db_path(&db_path);
    let parent = dir.parent().unwrap_or(&dir).to_path_buf();

    let cli_bin = std::env::var("AGENTGIT_CLI").unwrap_or_else(|_| "agentgit".to_string());

    let output = tokio::process::Command::new(&cli_bin)
        .arg("bundle")
        .arg("create")
        .arg(&session_id)
        .arg("-o")
        .arg(&out_path)
        .current_dir(&parent)
        .output()
        .await
        .map_err(|e| format!("failed to spawn '{}': {}", cli_bin, e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!("bundle create failed: {}\n{}", stderr, stdout));
    }

    Ok(json!({ "bundlePath": out_path }))
}

#[tauri::command]
async fn abandon_session(db_path: String, session_id: String) -> Result<(), String> {
    let pool = open_pool(&db_path).await?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as i64;

    sqlx::query("UPDATE sessions SET status = 'abandoned', updated_at = ? WHERE id = ?")
        .bind(now)
        .bind(&session_id)
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
async fn read_config(db_path: String) -> Result<Value, String> {
    let dir = agentgit_dir_from_db_path(&db_path);
    read_config_file(&dir)
}

#[tauri::command]
async fn write_config(db_path: String, config: Value) -> Result<(), String> {
    let dir = agentgit_dir_from_db_path(&db_path);
    write_config_file(&dir, &config)
}

#[tauri::command]
async fn add_remote(
    db_path: String,
    name: String,
    url: String,
    token: Option<String>,
) -> Result<RemoteRecord, String> {
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.') {
        return Err(format!("invalid remote name: {}", name));
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(format!("url must be http(s)://: {}", url));
    }
    let dir = agentgit_dir_from_db_path(&db_path);
    let mut cfg = read_config_file(&dir)?;
    let obj = cfg.as_object_mut().ok_or_else(|| "config must be an object".to_string())?;
    let remotes = obj
        .entry("remotes".to_string())
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| "remotes must be an object".to_string())?;
    if remotes.contains_key(&name) {
        return Err(format!("remote '{}' already exists", name));
    }
    let mut entry = Map::new();
    entry.insert("url".to_string(), Value::String(url.clone()));
    if let Some(t) = &token {
        entry.insert("token".to_string(), Value::String(t.clone()));
    }
    remotes.insert(name.clone(), Value::Object(entry));
    write_config_file(&dir, &cfg)?;
    Ok(RemoteRecord { name, url, token })
}

#[tauri::command]
async fn list_remotes(db_path: String) -> Result<Vec<RemoteRecord>, String> {
    let dir = agentgit_dir_from_db_path(&db_path);
    let cfg = read_config_file(&dir)?;
    let remotes = cfg.get("remotes").and_then(|v| v.as_object());
    let mut out = Vec::new();
    if let Some(map) = remotes {
        for (name, v) in map {
            let url = v.get("url").and_then(|u| u.as_str()).unwrap_or("").to_string();
            let token = v
                .get("token")
                .and_then(|t| t.as_str())
                .map(|s| s.to_string());
            out.push(RemoteRecord {
                name: name.clone(),
                url,
                token,
            });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Shells out to the `agentgit` CLI to perform a push. Returns the remote URL
/// composed into a shareable session link on success.
#[tauri::command]
async fn push_session(
    db_path: String,
    remote_name: String,
    session_id: String,
) -> Result<PushSessionResult, String> {
    let dir = agentgit_dir_from_db_path(&db_path);
    // Resolve the remote URL up front so we can build the share URL even if
    // the CLI subprocess prints nothing useful.
    let cfg = read_config_file(&dir)?;
    let url = cfg
        .get("remotes")
        .and_then(|r| r.get(&remote_name))
        .and_then(|r| r.get("url"))
        .and_then(|u| u.as_str())
        .ok_or_else(|| format!("unknown remote '{}'", remote_name))?
        .to_string();

    let cli_bin = std::env::var("AGENTGIT_CLI").unwrap_or_else(|_| "agentgit".to_string());
    let parent = dir.parent().unwrap_or(&dir).to_path_buf();

    let output = tokio::process::Command::new(&cli_bin)
        .arg("push")
        .arg(&remote_name)
        .arg(&session_id)
        .current_dir(&parent)
        .output()
        .await
        .map_err(|e| format!("failed to spawn '{}': {}", cli_bin, e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let combined = if stderr.is_empty() {
        stdout.clone()
    } else {
        format!("{}\n{}", stdout, stderr)
    };
    if !output.status.success() {
        return Err(combined);
    }

    let share_url = format!("{}/sessions/{}", url.trim_end_matches('/'), session_id);
    Ok(PushSessionResult {
        ok: true,
        remote: remote_name,
        session_id,
        share_url,
        output: combined,
    })
}

#[allow(dead_code)]
fn _ensure_json_imports_used() -> Value {
    json!({})
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
            get_blame,
            add_remote,
            list_remotes,
            push_session,
            create_session,
            replay_from_commit,
            export_bundle,
            abandon_session,
            read_config,
            write_config
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
