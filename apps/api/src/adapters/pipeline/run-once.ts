import type { Photo } from "../../domain/library/model.js";
import type { ClaimedJob } from "../../domain/library/ports.js";
import {
  checkEmbedding,
  embeddingInput,
  exifFill,
  failureDisposition,
  normalizeVisionDescription,
  normalizeVisionTags,
  shouldCallVision,
  thumbObjectKey,
  visionWrite,
  type PipelineErrorCode,
  type PipelineStep,
} from "../../domain/library/pipeline.js";
import type { PipelineDeps, WorkerControl } from "./deps.js";
import { pipelineFailureMessage } from "./failure-message.js";

export async function runOnce(deps: PipelineDeps, now: Date, limit: number, control?: WorkerControl): Promise<void> {
  const reclaimed = await deps.store.reclaimExpired(now);
  for (const job of reclaimed) {
    deps.log.info("任务租约回收", {
      jobId: job.id,
      jobType: job.type,
      photoId: job.photoId,
      attempt: job.attempts,
      errorCode: "interrupted",
    });
  }
  if (limit < 1) return;
  const claimed = await deps.store.claim(now, limit);
  for (const job of claimed) {
    control?.inflight.set(job.id, job.lockedAt);
    if (control?.stopped) continue;
    await runClaimed(deps, job, now);
    control?.inflight.delete(job.id);
  }
}

async function runClaimed(deps: PipelineDeps, job: ClaimedJob, now: Date): Promise<void> {
  let step: PipelineStep = job.type === "reembed" ? "embed" : job.step;
  let original: Buffer | null = null;
  for (let hop = 0; hop < 6 && step !== "done"; hop += 1) {
    if ((step === "exif" || step === "thumbnail" || step === "vision") && !original) {
      const loaded = await loadOriginal(deps, job, now);
      if (loaded === "stop") return;
      original = loaded;
    }
    if (step === "exif") {
      if ((await runExif(deps, job, original as Buffer, now)) === "stop") return;
      step = "thumbnail";
      continue;
    }
    if (step === "thumbnail") {
      if ((await runThumbnail(deps, job, original as Buffer, now)) === "stop") return;
      step = "vision";
      continue;
    }
    if (step === "vision") {
      if ((await runVision(deps, job, original as Buffer, now)) === "stop") return;
      step = "embed";
      continue;
    }
    if (step === "embed") {
      const next = await runEmbed(deps, job, now);
      if (next === "thumbnail") {
        step = "thumbnail";
        continue;
      }
      return;
    }
    return;
  }
}

async function loadOriginal(deps: PipelineDeps, job: ClaimedJob, now: Date): Promise<Buffer | "stop"> {
  const photo = await deps.store.readPhoto(job.photoId);
  if (!photo) {
    deps.log.warn("照片已删除", fields(job, photo, job.step));
    return "stop";
  }
  try {
    const object = await deps.storage.getObject({ key: photo.objectKey });
    if (!object) {
      await finishFailure(deps, job, "original_missing", now, photo, job.step);
      return "stop";
    }
    return object.body;
  } catch (error) {
    await finishFailure(deps, job, "storage", now, photo, job.step, errorName(error));
    return "stop";
  }
}

async function runExif(deps: PipelineDeps, job: ClaimedJob, bytes: Buffer, now: Date): Promise<"ok" | "stop"> {
  const photo = await deps.store.readPhoto(job.photoId);
  if (!photo) {
    deps.log.warn("照片已删除", fields(job, null, "exif"));
    return "stop";
  }
  const reading = await deps.exif.read(bytes);
  const advanced = await deps.store.applyExif({
    jobId: job.id,
    lockedAt: job.lockedAt,
    photoId: photo.id,
    fill: exifFill(photo, reading),
    now,
  });
  return advanced === "ok" ? "ok" : "stop";
}

async function runThumbnail(deps: PipelineDeps, job: ClaimedJob, bytes: Buffer, now: Date): Promise<"ok" | "stop"> {
  const photo = await deps.store.readPhoto(job.photoId);
  if (!photo) {
    deps.log.warn("照片已删除", fields(job, null, "thumbnail"));
    return "stop";
  }
  const expected = thumbObjectKey(photo.ownerId, photo.id);
  if (photo.thumbKey === expected) {
    try {
      const head = await deps.storage.headObject({ key: expected });
      if (head && head.byteSize >= 1) {
        const advanced = await deps.store.noteThumbPresent({ jobId: job.id, lockedAt: job.lockedAt, now });
        return advanced === "ok" ? "ok" : "stop";
      }
    } catch (error) {
      await finishFailure(deps, job, "storage", now, photo, "thumbnail", errorName(error));
      return "stop";
    }
  }
  let encoded: { bytes: Buffer; contentType: "image/jpeg" };
  try {
    encoded = await deps.thumbnail.encode(bytes);
  } catch (error) {
    const code = errorName(error) === "ThumbnailEncodeError" ? "thumbnail_failed" : "storage";
    await finishFailure(deps, job, code, now, photo, "thumbnail", errorName(error));
    return "stop";
  }
  try {
    await deps.storage.putObject({ key: expected, contentType: "image/jpeg", body: encoded.bytes });
  } catch (error) {
    await finishFailure(deps, job, "storage", now, photo, "thumbnail", errorName(error));
    return "stop";
  }
  const committed = await deps.store.commitThumb({
    jobId: job.id,
    lockedAt: job.lockedAt,
    photoId: photo.id,
    thumbKey: expected,
    now,
  });
  if (committed === "missing") {
    try {
      await deps.storage.deleteObject({ key: expected });
    } catch (error) {
      deps.log.warn("对象存储失败", { ...fields(job, photo, "thumbnail"), errorName: errorName(error) });
    }
    deps.log.warn("照片已删除", fields(job, photo, "thumbnail"));
    return "stop";
  }
  return committed === "ok" ? "ok" : "stop";
}

async function runVision(deps: PipelineDeps, job: ClaimedJob, bytes: Buffer, now: Date): Promise<"ok" | "stop"> {
  const photo = await deps.store.readPhoto(job.photoId);
  if (!photo) {
    deps.log.warn("照片已删除", fields(job, null, "vision"));
    return "stop";
  }
  if (!shouldCallVision(photo)) {
    const advanced = await deps.store.skipVision({ jobId: job.id, lockedAt: job.lockedAt, now });
    return advanced === "ok" ? "ok" : "stop";
  }
  try {
    const described = await deps.vision.describe({ model: deps.visionModel, contentType: photo.contentType, bytes });
    if (!described.ok) {
      await finishFailure(deps, job, described.kind, now, photo, "vision");
      return "stop";
    }
    const write = visionWrite(photo, {
      description: normalizeVisionDescription(described.description),
      tags: normalizeVisionTags(described.tags),
    });
    const advanced = await deps.store.applyVision({
      jobId: job.id,
      lockedAt: job.lockedAt,
      photoId: photo.id,
      description: write.description,
      tags: write.tags,
      now,
    });
    return advanced === "ok" ? "ok" : "stop";
  } catch (error) {
    await finishFailure(deps, job, "vision_unavailable", now, photo, "vision", errorName(error));
    return "stop";
  }
}

async function runEmbed(deps: PipelineDeps, job: ClaimedJob, now: Date): Promise<"stop" | "thumbnail"> {
  const photo = await deps.store.readPhoto(job.photoId);
  if (!photo) {
    deps.log.warn("照片已删除", fields(job, null, "embed"));
    return "stop";
  }
  const text = embeddingInput(photo);
  let embedded: Awaited<ReturnType<PipelineDeps["embed"]["embed"]>>;
  try {
    embedded = await deps.embed.embed({ model: deps.embedModel, text });
  } catch (error) {
    await finishFailure(deps, job, "embed_unavailable", now, photo, "embed", errorName(error));
    return "stop";
  }
  if (!embedded.ok) {
    await finishFailure(deps, job, embedded.kind, now, photo, "embed");
    return "stop";
  }
  const checked = checkEmbedding(embedded.values, deps.embedDimensions);
  if (!checked.ok) {
    await finishFailure(deps, job, checked.code, now, photo, "embed");
    return "stop";
  }
  try {
    const committed = await deps.store.commitEmbedding(
      {
        jobId: job.id,
        lockedAt: job.lockedAt,
        photoId: photo.id,
        jobType: job.type,
        values: embedded.values,
        dimensions: deps.embedDimensions,
        model: deps.embedModel,
        now,
      },
      (locked) => {
        if (embeddingInput(locked) !== text) return "text_changed";
        if (job.type === "process_photo" && locked.thumbKey === null) return "need_thumbnail";
        return "write";
      },
    );
    if (committed === "text_changed") {
      await deps.store.releaseRunning({ jobId: job.id, lockedAt: job.lockedAt, now });
      return "stop";
    }
    if (committed === "need_thumbnail") {
      const rewound = await deps.store.rewindToThumbnail({ jobId: job.id, lockedAt: job.lockedAt, now });
      return rewound === "ok" ? "thumbnail" : "stop";
    }
    if (committed === "missing") deps.log.warn("照片已删除", fields(job, photo, "embed"));
    return "stop";
  } catch (error) {
    const name = errorName(error);
    if (name === "DimensionMismatch") {
      await finishFailure(deps, job, "dimension_mismatch", now, photo, "embed", name);
      return "stop";
    }
    if (name === "InvalidEmbedding") {
      await finishFailure(deps, job, "invalid_embedding", now, photo, "embed", name);
      return "stop";
    }
    throw error;
  }
}

async function finishFailure(
  deps: PipelineDeps,
  job: ClaimedJob,
  code: PipelineErrorCode,
  now: Date,
  photo: Photo | null,
  step: PipelineStep,
  errorNameValue?: string,
): Promise<void> {
  const disposition = failureDisposition(code, job.attempts);
  if (disposition.outcome === "retry") {
    await deps.store.retryJob({
      jobId: job.id,
      lockedAt: job.lockedAt,
      photoId: job.photoId,
      jobType: job.type,
      code,
      runAfter: new Date(now.getTime() + disposition.delayMs),
      now,
    });
  } else {
    await deps.store.failJob({
      jobId: job.id,
      lockedAt: job.lockedAt,
      photoId: job.photoId,
      jobType: job.type,
      code,
      now,
    });
  }
  deps.log.warn(pipelineFailureMessage(code), { ...fields(job, photo, step), errorCode: code, errorName: errorNameValue });
}

function fields(job: ClaimedJob, photo: Photo | null, step: PipelineStep) {
  return {
    userId: photo?.ownerId,
    photoId: job.photoId,
    objectKey: photo?.objectKey,
    jobId: job.id,
    jobType: job.type,
    step,
    attempt: job.attempts,
  };
}

function errorName(error: unknown): string {
  if (typeof error === "object" && error !== null && "name" in error && typeof error.name === "string") return error.name;
  return "Error";
}
