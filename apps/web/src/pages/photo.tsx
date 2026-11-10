import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { api, type Photo } from "../api";
import {
  LOADING,
  NETWORK_MESSAGE,
  formatByteSize,
  formatLocalMinute,
  photoAlt,
  statusText,
  visibleMessage,
} from "../copy";
import { Dialog } from "./dialog";
import {
  buildPatch,
  saveNotice,
  takenAtToLocalInput,
  validateTags,
  type PhotoFormInput,
  type PhotoMetadataBaseline,
} from "./photo-form";
import { IMAGE_BROKEN, usePhotoUrlRefresh } from "./photo-url-refresh";

const POLL_INTERVAL_MS = 5000;

type PhotoPageProps = {
  id: string;
  onNavigate: (to: string, mode?: "push" | "replace") => void;
};

function baselineFromPhoto(photo: Photo): PhotoMetadataBaseline {
  return {
    description: photo.description,
    tags: [...photo.tags],
    takenAt: photo.takenAt,
    locationText: photo.locationText,
    latitude: photo.latitude,
    longitude: photo.longitude,
  };
}

function inputFromPhoto(photo: Photo): PhotoFormInput {
  return {
    description: photo.description ?? "",
    tags: [...photo.tags],
    takenAtLocal: takenAtToLocalInput(photo.takenAt),
    locationText: photo.locationText ?? "",
    latitude: photo.latitude === null ? "" : String(photo.latitude),
    longitude: photo.longitude === null ? "" : String(photo.longitude),
  };
}

export function PhotoPage({ id, onNavigate }: PhotoPageProps) {
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [displayPhoto, setDisplayPhoto] = useState<Photo | null>(null);
  const [brokenVisible, setBrokenVisible] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<PhotoFormInput | null>(null);
  const baselineRef = useRef<PhotoMetadataBaseline | null>(null);
  const [tagDraft, setTagDraft] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [saveNoticeText, setSaveNoticeText] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const errorSummaryRef = useRef<HTMLParagraphElement>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const photoRef = useRef(photo);
  photoRef.current = photo;

  const onDisplayUpdate = useCallback((next: Photo) => {
    setDisplayPhoto(next);
    setPhoto((prev) => (prev !== null && prev.id === next.id ? next : prev));
  }, []);

  const refreshSource = displayPhoto ?? photo;
  const { onImageError } = usePhotoUrlRefresh(
    refreshSource ?? {
      id,
      contentType: "image/jpeg",
      byteSize: 0,
      takenAt: null,
      locationText: null,
      latitude: null,
      longitude: null,
      description: null,
      tags: [],
      status: "ready",
      errorCode: null,
      originalUrl: "",
      originalUrlExpiresAt: new Date(0).toISOString(),
      thumbUrl: null,
      thumbUrlExpiresAt: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
    onDisplayUpdate,
    setBrokenVisible,
  );

  const replacePhoto = useCallback((next: Photo) => {
    setPhoto(next);
    setDisplayPhoto(next);
    setForm(inputFromPhoto(next));
    baselineRef.current = baselineFromPhoto(next);
    setBrokenVisible(false);
  }, []);

  const fetchPhoto = useCallback(
    async (signal: AbortSignal) => {
      const result = await api.getPhoto(id);
      if (signal.aborted) return;
      if (result.ok) {
        setLoadError(null);
        replacePhoto(result.data);
        return;
      }
      if (result.kind === "aborted") return;
      if (result.kind === "network") {
        setLoadError(NETWORK_MESSAGE);
        return;
      }
      setLoadError(
        visibleMessage({
          status: result.status,
          code: result.code,
          serverMessage: result.serverMessage,
          audience: "general",
        }),
      );
    },
    [id, replacePhoto],
  );

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    setInitialLoading(true);
    void (async () => {
      await fetchPhoto(controller.signal);
      if (!controller.signal.aborted) setInitialLoading(false);
    })();
    return () => controller.abort();
  }, [fetchPhoto]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      const current = photoRef.current;
      if (current === null || current.status !== "processing") return;
      const controller = abortRef.current;
      const signal = controller?.signal ?? new AbortController().signal;
      void fetchPhoto(signal);
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [fetchPhoto]);

  const addTag = () => {
    if (form === null) return;
    const trimmed = tagDraft.trim();
    if (trimmed === "") return;
    const validated = validateTags([...form.tags, trimmed]);
    if (!validated.ok) {
      setFormError(validated.message);
      errorSummaryRef.current?.focus();
      return;
    }
    setFormError(null);
    setForm({ ...form, tags: validated.tags });
    setTagDraft("");
  };

  const removeTag = (index: number) => {
    if (form === null) return;
    setForm({ ...form, tags: form.tags.filter((_, i) => i !== index) });
  };

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    if (form === null || photo === null || baselineRef.current === null || saving) return;
    setSaveNoticeText(null);
    setActionError(null);
    const patch = buildPatch(form, baselineRef.current);
    if (!patch.ok) {
      setFormError(patch.message);
      errorSummaryRef.current?.focus();
      return;
    }
    setFormError(null);
    setSaving(true);
    const result = await api.patchPhoto(photo.id, patch.body);
    setSaving(false);
    if (result.ok) {
      replacePhoto(result.data);
      setSaveNoticeText(
        saveNotice(result.data.status, patch.descriptionChanged, patch.tagsChanged),
      );
      return;
    }
    if (result.kind === "network") {
      setActionError(NETWORK_MESSAGE);
      return;
    }
    if (result.kind === "http") {
      setActionError(
        visibleMessage({
          status: result.status,
          code: result.code,
          serverMessage: result.serverMessage,
          audience: "general",
        }),
      );
    }
  };

  const handleRetry = async () => {
    if (photo === null || retrying) return;
    setActionError(null);
    setRetrying(true);
    const result = await api.retryPhoto(photo.id);
    setRetrying(false);
    if (result.ok && result.data !== null) {
      replacePhoto(result.data);
      return;
    }
    if (result.ok) return;
    if (result.kind === "network") {
      setActionError(NETWORK_MESSAGE);
      return;
    }
    if (result.kind === "http" && result.status === 409 && result.serverMessage === "照片不在失败状态") {
      setActionError("照片不在失败状态");
      return;
    }
    if (result.kind === "http") {
      setActionError(
        visibleMessage({
          status: result.status,
          code: result.code,
          serverMessage: result.serverMessage,
          audience: "general",
        }),
      );
    }
  };

  const handleDeleteConfirm = async () => {
    if (photo === null || deleting) return;
    setDeleting(true);
    const result = await api.deletePhoto(photo.id);
    setDeleting(false);
    setDeleteOpen(false);
    if (result.ok) {
      if (result.status === 204) {
        onNavigate("/", "replace");
      }
      return;
    }
    if (result.kind === "aborted") return;
    if (result.kind === "network") {
      setActionError(NETWORK_MESSAGE);
      return;
    }
    setActionError(
      visibleMessage({
        status: result.status,
        code: result.code,
        serverMessage: result.serverMessage,
        audience: "general",
      }),
    );
  };

  if (initialLoading) {
    return (
      <section className="page-block">
        <p>{LOADING}</p>
      </section>
    );
  }

  if (loadError !== null || photo === null || form === null || refreshSource === null) {
    return (
      <section className="page-block">
        <p role="alert">{loadError ?? "未找到"}</p>
      </section>
    );
  }

  const status = statusText(refreshSource.status, refreshSource.errorCode);

  return (
    <section className="page-block photo-page">
      <div className="photo-detail-media">
        <img
          className="photo-detail-image"
          src={refreshSource.originalUrl}
          alt={photoAlt(refreshSource.description)}
          onError={onImageError}
        />
        {brokenVisible ? <p className="photo-card-broken">{IMAGE_BROKEN}</p> : null}
      </div>
      <p aria-live="polite">{status}</p>
      <p>{refreshSource.contentType}</p>
      <p>{formatByteSize(refreshSource.byteSize)}</p>
      <p>{formatLocalMinute(refreshSource.createdAt)}</p>

      {saveNoticeText !== null ? <p className="banner">{saveNoticeText}</p> : null}
      {actionError !== null ? (
        <p className="banner" role="alert">
          {actionError}
        </p>
      ) : null}

      <form className="stack-form photo-form" onSubmit={(e) => void handleSave(e)}>
        {formError !== null ? (
          <p ref={errorSummaryRef} className="field-error" tabIndex={-1} role="alert">
            {formError}
          </p>
        ) : null}
        <label>
          描述
          <textarea
            value={form.description}
            rows={4}
            onChange={(event) => setForm({ ...form, description: event.target.value })}
          />
        </label>
        <div className="tag-field">
          <label>
            标签
            <input
              type="text"
              value={tagDraft}
              onChange={(event) => setTagDraft(event.target.value)}
              onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addTag();
                }
              }}
            />
          </label>
          <button type="button" onClick={addTag}>
            添加标签
          </button>
          <ul className="tag-chips">
            {form.tags.map((tag, index) => (
              <li key={`${tag}-${index}`}>
                <span>{tag}</span>
                <button type="button" aria-label={`移除 ${tag}`} onClick={() => removeTag(index)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
        <label>
          拍摄时间
          <input
            type="datetime-local"
            value={form.takenAtLocal}
            onChange={(event) => setForm({ ...form, takenAtLocal: event.target.value })}
          />
        </label>
        <label>
          地点
          <input
            type="text"
            value={form.locationText}
            onChange={(event) => setForm({ ...form, locationText: event.target.value })}
          />
        </label>
        <label>
          纬度
          <input
            type="text"
            inputMode="decimal"
            value={form.latitude}
            onChange={(event) => setForm({ ...form, latitude: event.target.value })}
          />
        </label>
        <label>
          经度
          <input
            type="text"
            inputMode="decimal"
            value={form.longitude}
            onChange={(event) => setForm({ ...form, longitude: event.target.value })}
          />
        </label>
        <p>
          <button type="submit" disabled={saving}>
            保存
          </button>
        </p>
      </form>

      <p className="photo-actions">
        {photo.status === "failed" ? (
          <button type="button" disabled={retrying} onClick={() => void handleRetry()}>
            重试
          </button>
        ) : null}
        <button type="button" ref={deleteTriggerRef} onClick={() => setDeleteOpen(true)}>
          删除
        </button>
      </p>

      <Dialog
        open={deleteOpen}
        title="删除照片"
        confirmLabel="删除"
        cancelLabel="取消"
        returnFocusRef={deleteTriggerRef}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => void handleDeleteConfirm()}
      >
        <p>删除这张照片？此操作不能撤销。</p>
      </Dialog>
    </section>
  );
}
