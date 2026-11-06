import type { KeywordCursor, SemanticCursor } from "./cursor.js";

export type SearchPhoto = {
  id: string;
  ownerId: string;
  objectKey: string;
  thumbKey: string | null;
  contentType: string;
  byteSize: number;
  takenAt: Date | null;
  locationText: string | null;
  latitude: number | null;
  longitude: number | null;
  description: string | null;
  tags: string[];
  status: "ready";
  sourceUserId: string | null;
  sourceKeyId: string | null;
  errorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SearchHit = {
  photo: SearchPhoto;
  scoreText: string | null;
};

export type SearchKeywordInput = {
  ownerId: string;
  pattern: string;
  takenFrom: Date | null;
  takenTo: Date | null;
  tags: string[] | null;
  cursor: KeywordCursor | null;
  limit: number;
};

export type SearchSemanticInput = {
  ownerId: string;
  values: number[];
  dimensions: 1536;
  takenFrom: Date | null;
  takenTo: Date | null;
  tags: string[] | null;
  cursor: SemanticCursor | null;
  limit: number;
};

export type SearchPort = {
  searchKeyword(input: SearchKeywordInput): Promise<SearchHit[]>;
  searchSemantic(input: SearchSemanticInput): Promise<SearchHit[]>;
};
