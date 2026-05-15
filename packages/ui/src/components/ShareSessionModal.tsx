import { useEffect, useState } from "react";
import {
  addRemote,
  listRemotes,
  pushSession,
  type PushSessionResult,
  type RemoteRecord,
} from "../ipc.js";

export interface ShareSessionModalProps {
  /** Path to the local `.agentgit/index.db` so Tauri IPC can resolve the repo. */
  dbPath: string;
  /** Session id to push. */
  sessionId: string;
  /** Called when the user closes the dialog. */
  onClose: () => void;
  /**
   * Override for clipboard write — defaults to navigator.clipboard.writeText.
   * Tests inject a spy.
   */
  writeToClipboard?: (text: string) => Promise<void>;
}

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "pushing"; remote: string }
  | { kind: "success"; result: PushSessionResult }
  | { kind: "error"; message: string };

function defaultClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    return navigator.clipboard.writeText(text);
  }
  return Promise.resolve();
}

/**
 * Modal dialog that lets the user pick a configured remote (or add a new one)
 * and pushes the current session to it. On success, the shareable URL is
 * copied to the clipboard and surfaced as a toast.
 */
export function ShareSessionModal({
  dbPath,
  sessionId,
  onClose,
  writeToClipboard,
}: ShareSessionModalProps) {
  const [remotes, setRemotes] = useState<RemoteRecord[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [status, setStatus] = useState<Status>({ kind: "loading" });

  // "Add new" form state.
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [newToken, setNewToken] = useState("");
  const [addingNew, setAddingNew] = useState(false);

  const clipboard = writeToClipboard ?? defaultClipboard;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await listRemotes(dbPath);
        if (cancelled) return;
        setRemotes(list);
        if (list.length > 0 && list[0]) setSelected(list[0].name);
        setStatus({ kind: "idle" });
      } catch (err) {
        if (cancelled) return;
        setStatus({ kind: "error", message: (err as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dbPath]);

  async function handleAddRemote(): Promise<void> {
    try {
      const tok = newToken.trim() === "" ? undefined : newToken.trim();
      const added = await addRemote(dbPath, newName.trim(), newUrl.trim(), tok);
      setRemotes((prev) => [...prev, added]);
      setSelected(added.name);
      setAddingNew(false);
      setNewName("");
      setNewUrl("");
      setNewToken("");
    } catch (err) {
      setStatus({ kind: "error", message: (err as Error).message });
    }
  }

  async function handlePush(): Promise<void> {
    if (!selected) return;
    setStatus({ kind: "pushing", remote: selected });
    try {
      const result = await pushSession(dbPath, selected, sessionId);
      try {
        await clipboard(result.shareUrl);
      } catch {
        // Clipboard failure is non-fatal — the URL is still shown.
      }
      setStatus({ kind: "success", result });
    } catch (err) {
      setStatus({ kind: "error", message: (err as Error).message });
    }
  }

  return (
    <div
      role="dialog"
      aria-label="Share session"
      className="agentgit-share-modal"
      data-testid="share-session-modal"
    >
      <div className="agentgit-share-modal__header">
        <h2>Share session</h2>
        <button type="button" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <div className="agentgit-share-modal__body">
        {status.kind === "loading" ? (
          <p>Loading remotes…</p>
        ) : null}

        {status.kind !== "loading" && remotes.length === 0 && !addingNew ? (
          <p>
            No remotes configured.{" "}
            <button type="button" onClick={() => setAddingNew(true)}>
              Add one
            </button>
          </p>
        ) : null}

        {remotes.length > 0 ? (
          <div>
            <label htmlFor="agentgit-share-remote">Remote</label>
            <select
              id="agentgit-share-remote"
              value={selected}
              onChange={(e) => setSelected(e.currentTarget.value)}
              data-testid="share-remote-select"
            >
              {remotes.map((r) => (
                <option key={r.name} value={r.name}>
                  {r.name} — {r.url}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => setAddingNew((v) => !v)}>
              {addingNew ? "Cancel" : "Add another"}
            </button>
          </div>
        ) : null}

        {addingNew ? (
          <div className="agentgit-share-modal__add">
            <input
              placeholder="name (e.g. team)"
              value={newName}
              onChange={(e) => setNewName(e.currentTarget.value)}
            />
            <input
              placeholder="https://remote.example.com"
              value={newUrl}
              onChange={(e) => setNewUrl(e.currentTarget.value)}
            />
            <input
              placeholder="bearer token"
              value={newToken}
              onChange={(e) => setNewToken(e.currentTarget.value)}
            />
            <button
              type="button"
              onClick={handleAddRemote}
              disabled={newName.trim() === "" || newUrl.trim() === ""}
            >
              Add remote
            </button>
          </div>
        ) : null}

        {status.kind === "pushing" ? <p>Pushing to {status.remote}…</p> : null}

        {status.kind === "success" ? (
          <div className="agentgit-share-modal__success" role="status">
            <p>
              Shared! URL copied to clipboard:
              <br />
              <code data-testid="share-url">{status.result.shareUrl}</code>
            </p>
          </div>
        ) : null}

        {status.kind === "error" ? (
          <p role="alert" className="agentgit-share-modal__error">
            {status.message}
          </p>
        ) : null}
      </div>

      <div className="agentgit-share-modal__footer">
        <button
          type="button"
          onClick={handlePush}
          disabled={!selected || status.kind === "pushing"}
          data-testid="share-push-button"
        >
          Push & copy link
        </button>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

export default ShareSessionModal;
