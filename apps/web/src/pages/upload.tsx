import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { api, type ApiResult } from "../api";
import {
  UPLOAD_CANCELLED_MESSAGE,
  UPLOAD_CLOSED_MESSAGE,
  UPLOAD_COMPLETING_MESSAGE,
  UNSUPPORTED_TYPE_MESSAGE,
  contentTypeForFile,
  onCompleting,
  uploadFailure,
  uploadFailureVisibleMessage,
  validateFileSize,
  type UploadAction,
  type UploadFailureInput,
} from "./upload-machine";

type UploadPageProps = {
  onNavigate: (to: string, mode?: "push" | "replace") => void;
};

type PipelineStep = "create" | "part" | "complete" | "abort";

type FailureState = {
  step: PipelineStep;
  failure: UploadFailureInput;
  action: UploadAction;
  message: string;
};

function apiFailure(
  result: Extract<ApiResult<unknown>, { ok: false }>,
): UploadFailureInput {
  if (result.kind === "network") {
    return { network: true, status: null, code: null, serverMessage: null };
  }
  if (result.kind === "http") {
    return {
      network: false,
      status: result.status,
      code: result.code,
      serverMessage: result.serverMessage,
    };
  }
  return { network: false, status: null, code: null, serverMessage: null };
}

export function UploadPage({ onNavigate }: UploadPageProps) {
  const [stepLabel, setStepLabel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<FailureState | null>(null);
  const [terminalMessage, setTerminalMessage] = useState<string | null>(null);
  const [autoCompleteAttempts, setAutoCompleteAttempts] = useState<number | null>(null);
  const [awaitingContinue, setAwaitingContinue] = useState(false);

  const sessionRef = useRef({
    uploadId: null as string | null,
    photoId: null as string | null,
    file: null as File | null,
  });
  const runIdRef = useRef(0);

  const resetForm = useCallback(() => {
    setStepLabel(null);
    setBusy(false);
    setFailure(null);
    setAutoCompleteAttempts(null);
    setAwaitingContinue(false);
    sessionRef.current = { uploadId: null, photoId: null, file: null };
  }, []);

  const navigateToPhoto = useCallback(
    (id: string) => {
      onNavigate(`/photos/${id}`, "push");
    },
    [onNavigate],
  );

  const completeOnce = useCallback(
    async (runId: number): Promise<void> => {
      const id = sessionRef.current.uploadId;
      if (id === null) return;
      setStepLabel("正在完成");
      const result = await api.completeUpload(id);
      if (runId !== runIdRef.current) return;
      if (result.ok) {
        resetForm();
        navigateToPhoto(result.data.id);
        return;
      }
      if (
        result.kind === "http" &&
        result.status === 409 &&
        result.code === "upload_completed" &&
        sessionRef.current.photoId !== null
      ) {
        const savedPhotoId = sessionRef.current.photoId;
        resetForm();
        navigateToPhoto(savedPhotoId);
        return;
      }
      const fail = apiFailure(result);
      const action = uploadFailure("complete", fail);
      if (action.kind === "finish-via-complete") {
        const retry = await api.completeUpload(id);
        if (runId !== runIdRef.current) return;
        if (retry.ok) {
          resetForm();
          navigateToPhoto(retry.data.id);
          return;
        }
        if (
          retry.kind === "http" &&
          retry.status === 409 &&
          retry.code === "upload_completed" &&
          sessionRef.current.photoId !== null
        ) {
          const savedPhotoId = sessionRef.current.photoId;
          resetForm();
          navigateToPhoto(savedPhotoId);
          return;
        }
        setBusy(false);
        setStepLabel(null);
        setAutoCompleteAttempts(null);
        setAwaitingContinue(false);
        setFailure({
          step: "complete",
          failure: apiFailure(retry),
          action: uploadFailure("complete", apiFailure(retry)),
          message: uploadFailureVisibleMessage("complete", apiFailure(retry)),
        });
        return;
      }
      if (action.kind === "closed") {
        resetForm();
        setTerminalMessage(UPLOAD_CLOSED_MESSAGE);
        return;
      }
      if (action.kind === "enter-auto-complete") {
        setFailure(null);
        setStepLabel(null);
        setBusy(true);
        setAutoCompleteAttempts(3);
        setAwaitingContinue(false);
        setTerminalMessage(UPLOAD_COMPLETING_MESSAGE);
        return;
      }
      setBusy(false);
      setStepLabel(null);
      setAutoCompleteAttempts(null);
      setAwaitingContinue(false);
      setTerminalMessage(null);
      setFailure({
        step: "complete",
        failure: fail,
        action,
        message: uploadFailureVisibleMessage("complete", fail),
      });
    },
    [navigateToPhoto, resetForm],
  );

  const applyStepFailure = useCallback(
    (step: PipelineStep, input: UploadFailureInput) => {
      const action = uploadFailure(step, input);
      if (action.kind === "closed") {
        resetForm();
        setTerminalMessage(UPLOAD_CLOSED_MESSAGE);
        return;
      }
      if (action.kind === "enter-auto-complete") {
        setFailure(null);
        setStepLabel(null);
        setBusy(true);
        setAutoCompleteAttempts(3);
        setAwaitingContinue(false);
        setTerminalMessage(UPLOAD_COMPLETING_MESSAGE);
        return;
      }
      if (action.kind === "finish-via-complete") {
        setFailure(null);
        setTerminalMessage(null);
        setAutoCompleteAttempts(null);
        setAwaitingContinue(false);
        void completeOnce(++runIdRef.current);
        return;
      }
      setBusy(false);
      setStepLabel(null);
      setAutoCompleteAttempts(null);
      setAwaitingContinue(false);
      setTerminalMessage(null);
      setFailure({
        step,
        failure: input,
        action,
        message: uploadFailureVisibleMessage(step, input),
      });
    },
    [completeOnce, resetForm],
  );

  const runPipeline = useCallback(
    async (file: File, contentType: string, fromStep: "create" | "part") => {
      const runId = ++runIdRef.current;
      setBusy(true);
      setFailure(null);
      setTerminalMessage(null);
      setAwaitingContinue(false);
      setAutoCompleteAttempts(null);

      let currentUploadId = sessionRef.current.uploadId;

      if (fromStep === "create") {
        sessionRef.current.uploadId = null;
        sessionRef.current.photoId = null;
        setStepLabel("正在创建上传");
        const created = await api.createUpload(contentType, file.size);
        if (runId !== runIdRef.current) return;
        if (!created.ok) {
          applyStepFailure("create", apiFailure(created));
          return;
        }
        currentUploadId = created.data.uploadId;
        sessionRef.current.uploadId = currentUploadId;
        sessionRef.current.photoId = created.data.photoId;
      }

      if (currentUploadId === null) return;
      setStepLabel("正在上传");
      const part = await api.putPart(currentUploadId, file);
      if (runId !== runIdRef.current) return;
      if (!part.ok) {
        applyStepFailure("part", apiFailure(part));
        return;
      }

      await completeOnce(runId);
    },
    [applyStepFailure, completeOnce],
  );

  const startUpload = useCallback(
    (file: File) => {
      const contentType = contentTypeForFile(file.type, file.name);
      if (contentType === null) {
        resetForm();
        setTerminalMessage(UNSUPPORTED_TYPE_MESSAGE);
        return;
      }
      const sizeCheck = validateFileSize(file.size);
      if (!sizeCheck.ok) {
        resetForm();
        setTerminalMessage(sizeCheck.message);
        return;
      }
      sessionRef.current.file = file;
      void runPipeline(file, contentType, "create");
    },
    [resetForm, runPipeline],
  );

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (file === null) return;
    startUpload(file);
  };

  const handleCancel = () => {
    runIdRef.current += 1;
    const id = sessionRef.current.uploadId;
    if (id === null) {
      resetForm();
      setTerminalMessage(UPLOAD_CANCELLED_MESSAGE);
      return;
    }
    setBusy(true);
    setStepLabel(null);
    void (async () => {
      const result = await api.abortUpload(id);
      if (result.ok) {
        resetForm();
        setTerminalMessage(UPLOAD_CANCELLED_MESSAGE);
        return;
      }
      applyStepFailure("abort", apiFailure(result));
    })();
  };

  const handleActionButton = () => {
    if (awaitingContinue) {
      setBusy(true);
      setFailure(null);
      setTerminalMessage(UPLOAD_COMPLETING_MESSAGE);
      void completeOnce(++runIdRef.current);
      return;
    }
    const file = sessionRef.current.file;
    if (failure === null || failure.action.kind !== "button") return;
    const { action } = failure;
    setFailure(null);
    if (action.action === "restart") {
      if (file !== null) {
        const contentType = contentTypeForFile(file.type, file.name);
        if (contentType !== null) {
          void runPipeline(file, contentType, "create");
        }
      }
      return;
    }
    if (file === null) return;
    const contentType = contentTypeForFile(file.type, file.name);
    if (contentType === null) return;
    if (action.action === "retry-part" || action.action === "retry-part-then-complete") {
      void runPipeline(file, contentType, "part");
      return;
    }
    if (action.action === "complete") {
      setBusy(true);
      setTerminalMessage(null);
      void completeOnce(++runIdRef.current);
      return;
    }
    if (action.action === "abort") {
      const id = sessionRef.current.uploadId;
      if (id === null) return;
      setBusy(true);
      void (async () => {
        const result = await api.abortUpload(id);
        if (result.ok) {
          resetForm();
          setTerminalMessage(UPLOAD_CANCELLED_MESSAGE);
          return;
        }
        applyStepFailure("abort", apiFailure(result));
      })();
    }
  };

  useEffect(() => {
    if (autoCompleteAttempts === null) return;
    const decision = onCompleting(autoCompleteAttempts);
    if (decision.kind === "button") {
      setBusy(false);
      setStepLabel(null);
      setAwaitingContinue(true);
      setTerminalMessage(UPLOAD_COMPLETING_MESSAGE);
      return;
    }
    const runId = ++runIdRef.current;
    const timer = window.setTimeout(() => {
      setAutoCompleteAttempts(decision.attemptsLeft);
      void completeOnce(runId);
    }, decision.delayMs);
    return () => window.clearTimeout(timer);
  }, [autoCompleteAttempts, completeOnce]);

  const showCancel =
    busy &&
    autoCompleteAttempts === null &&
    !awaitingContinue &&
    failure === null &&
    (stepLabel === "正在创建上传" || stepLabel === "正在上传");

  const summary =
    terminalMessage ??
    failure?.message ??
    null;

  const actionButtonLabel =
    failure?.action.kind === "button"
      ? failure.action.label
      : awaitingContinue
        ? "继续完成"
        : null;

  return (
    <section className="page-block">
      <h1>上传</h1>
      {summary !== null ? (
        <p className="form-summary" role="alert" aria-live="polite">
          {summary}
        </p>
      ) : null}
      {stepLabel !== null && busy ? <p>{stepLabel}</p> : null}
      <p>
        <label>
          选择文件
          <input type="file" accept="image/*,.heic,.heif,.cr2,.nef,.arw,.dng" onChange={handleFileChange} />
        </label>
      </p>
      <p className="button-row">
        {showCancel ? (
          <button type="button" onClick={handleCancel}>
            取消
          </button>
        ) : null}
        {actionButtonLabel !== null ? (
          <button type="button" onClick={handleActionButton}>
            {actionButtonLabel}
          </button>
        ) : null}
      </p>
    </section>
  );
}
