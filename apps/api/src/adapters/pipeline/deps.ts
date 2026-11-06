import type { EmbedGateway, ExifReader, ObjectStorage, PipelineLog, PipelineStore, ThumbnailEncoder, VisionGateway } from "../../domain/library/ports.js";

export type { PipelineLog, PipelineLogFields } from "../../domain/library/ports.js";

export type PipelineDeps = {
  store: PipelineStore;
  storage: ObjectStorage;
  exif: ExifReader;
  thumbnail: ThumbnailEncoder;
  vision: VisionGateway;
  embed: EmbedGateway;
  log: PipelineLog;
  visionModel: string;
  embedModel: string;
  embedDimensions: number;
};

export type WorkerControl = {
  stopped: boolean;
  inflight: Map<string, Date>;
};
