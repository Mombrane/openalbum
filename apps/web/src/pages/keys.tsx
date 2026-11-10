import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, type ApiKey } from "../api";
import { formatLocalMinute, LOADING, NETWORK_MESSAGE, visibleMessage } from "../copy";
import { Dialog } from "./dialog";
import { validateKeyName } from "./key-form";

type KeysPageProps = {
  onNavigate: (to: string, mode?: "push" | "replace") => void;
};

type ListError =
  | { kind: "network" }
  | { kind: "http"; status: number; code: string | null; serverMessage: string | null };

export function KeysPage({ onNavigate: _onNavigate }: KeysPageProps) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<ListError | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [formSummary, setFormSummary] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const createTriggerRef = useRef<HTMLButtonElement>(null);

  const clearSecret = useCallback(() => {
    setSecret(null);
    setCopyNotice(null);
  }, []);

  useEffect(() => {
    return () => {
      setSecret(null);
    };
  }, []);

  const loadKeys = useCallback(async (signal?: AbortSignal) => {
    const result = await api.listKeys(signal);
    if (signal?.aborted) return false;
    if (result.ok) {
      setListError(null);
      setKeys(result.data.apiKeys);
      return true;
    }
    if (!result.ok && result.kind === "aborted") return false;
    if (result.kind === "network") {
      setListError({ kind: "network" });
      return false;
    }
    if (result.kind === "http") {
      setListError({
        kind: "http",
        status: result.status,
        code: result.code,
        serverMessage: result.serverMessage,
      });
      return false;
    }
    return false;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      setLoading(true);
      await loadKeys(controller.signal);
      if (!controller.signal.aborted) setLoading(false);
    })();
    return () => controller.abort();
  }, [loadKeys]);

  const listErrorMessage =
    listError === null
      ? null
      : listError.kind === "network"
        ? NETWORK_MESSAGE
        : visibleMessage({
            status: listError.status,
            code: listError.code,
            serverMessage: listError.serverMessage,
            audience: "general",
          });

  const handleCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validated = validateKeyName(nameInput);
    if (!validated.ok) {
      setFormSummary(validated.message);
      return;
    }
    setFormSummary(null);
    setCreating(true);
    void (async () => {
      const result = await api.createKey(validated.name);
      setCreating(false);
      if (result.ok) {
        setNameInput("");
        setSecret(result.data.secret);
        await loadKeys();
        return;
      }
      if (result.kind === "network") {
        setFormSummary(NETWORK_MESSAGE);
        return;
      }
      if (result.kind === "http") {
        setFormSummary(
          visibleMessage({
            status: result.status,
            code: result.code,
            serverMessage: result.serverMessage,
            audience: "general",
          }),
        );
      }
    })();
  };

  const handleRevoke = (id: string) => {
    setRevokingId(id);
    void (async () => {
      const result = await api.revokeKey(id);
      setRevokingId(null);
      if (result.ok) {
        await loadKeys();
        return;
      }
      if (result.kind === "network") {
        setFormSummary(NETWORK_MESSAGE);
        return;
      }
      if (result.kind === "http") {
        setFormSummary(
          visibleMessage({
            status: result.status,
            code: result.code,
            serverMessage: result.serverMessage,
            audience: "general",
          }),
        );
      }
    })();
  };

  const handleCopySecret = () => {
    if (secret === null) return;
    void navigator.clipboard.writeText(secret).then(
      () => setCopyNotice(null),
      () => setCopyNotice("复制失败，请手动选择"),
    );
  };

  return (
    <section className="page-block">
      <h1>API Key</h1>

      {formSummary !== null ? (
        <p className="form-summary" role="alert" aria-live="polite">
          {formSummary}
        </p>
      ) : null}

      <form className="stack-form keys-create-form" onSubmit={handleCreate}>
        <label>
          名称
          <input
            type="text"
            value={nameInput}
            onChange={(event) => setNameInput(event.target.value)}
            autoComplete="off"
          />
        </label>
        <p>
          <button type="submit" ref={createTriggerRef} disabled={creating}>
            创建
          </button>
        </p>
      </form>

      {loading ? (
        <p>{LOADING}</p>
      ) : listErrorMessage !== null ? (
        <p className="form-summary" role="alert">
          {listErrorMessage}
        </p>
      ) : keys.length === 0 ? (
        <p>还没有 API Key</p>
      ) : (
        <table className="keys-table">
          <thead>
            <tr>
              <th scope="col">名称</th>
              <th scope="col">前缀</th>
              <th scope="col">创建时间</th>
              <th scope="col">最近使用</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key.id}>
                <td>{key.name}</td>
                <td>
                  <code className="key-prefix">{key.keyPrefix}</code>
                </td>
                <td>{formatLocalMinute(key.createdAt)}</td>
                <td>
                  {key.lastUsedAt === null ? "从未使用" : formatLocalMinute(key.lastUsedAt)}
                </td>
                <td>
                  {key.revokedAt !== null ? (
                    "已吊销"
                  ) : (
                    <button
                      type="button"
                      disabled={revokingId === key.id}
                      onClick={() => handleRevoke(key.id)}
                    >
                      吊销
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Dialog
        open={secret !== null}
        title="新 API Key"
        confirmLabel="复制"
        cancelLabel="关闭"
        returnFocusRef={createTriggerRef}
        onClose={clearSecret}
        onConfirm={handleCopySecret}
      >
        <p>关闭后无法再次查看。</p>
        {copyNotice !== null ? (
          <p className="form-summary" role="status">
            {copyNotice}
          </p>
        ) : null}
        <label>
          密钥
          <input type="text" readOnly value={secret ?? ""} />
        </label>
      </Dialog>
    </section>
  );
}
