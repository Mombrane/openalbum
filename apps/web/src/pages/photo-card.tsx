import { useEffect, useRef, useState } from "react";
import { api, type Photo } from "../api";
import {
  formatByteSize,
  formatLocalMinute,
  formatScore,
  photoAlt,
  statusText,
} from "../copy";

const IMAGE_BROKEN = "图片暂时无法显示";
const REFRESH_LEAD_MS = 60_000;

function refreshAtMs(photo: Photo): number | null {
  const times: number[] = [];
  const original = Date.parse(photo.originalUrlExpiresAt);
  if (!Number.isNaN(original)) times.push(original);
  if (photo.thumbUrlExpiresAt !== null) {
    const thumb = Date.parse(photo.thumbUrlExpiresAt);
    if (!Number.isNaN(thumb)) times.push(thumb);
  }
  if (times.length === 0) return null;
  return Math.min(...times) - REFRESH_LEAD_MS;
}

type PhotoCardProps = {
  photo: Photo;
  score: number | null;
  showScore: boolean;
  onNavigate: (to: string, mode?: "push" | "replace") => void;
};

export function PhotoCard({ photo, score, showScore, onNavigate }: PhotoCardProps) {
  const [displayPhoto, setDisplayPhoto] = useState(photo);
  const [brokenVisible, setBrokenVisible] = useState(false);
  const errorRetriesRef = useRef(0);

  useEffect(() => {
    setDisplayPhoto(photo);
    setBrokenVisible(false);
    errorRetriesRef.current = 0;
  }, [photo.id]);

  useEffect(() => {
    setDisplayPhoto(photo);
  }, [photo]);

  const refreshOnce = (id: string) => {
    void (async () => {
      const result = await api.getPhoto(id);
      if (result.ok) {
        setDisplayPhoto(result.data);
        setBrokenVisible(false);
      }
    })();
  };

  useEffect(() => {
    const at = refreshAtMs(displayPhoto);
    if (at === null) return;
    const delay = at - Date.now();
    if (delay <= 0) {
      refreshOnce(displayPhoto.id);
      return;
    }
    const timer = window.setTimeout(() => {
      refreshOnce(displayPhoto.id);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [
    displayPhoto.id,
    displayPhoto.originalUrlExpiresAt,
    displayPhoto.thumbUrlExpiresAt,
  ]);

  const handleImageError = () => {
    if (errorRetriesRef.current === 0) {
      errorRetriesRef.current = 1;
      refreshOnce(displayPhoto.id);
      return;
    }
    setBrokenVisible(true);
  };

  const status = statusText(displayPhoto.status, displayPhoto.errorCode);
  const href = `/photos/${displayPhoto.id}`;

  return (
    <a
      className="photo-card"
      href={href}
      onClick={(event) => {
        event.preventDefault();
        onNavigate(href, "push");
      }}
    >
      <div className="photo-card-media">
        {displayPhoto.thumbUrl !== null ? (
          <img
            className="photo-card-thumb"
            src={displayPhoto.thumbUrl}
            alt={photoAlt(displayPhoto.description)}
            onError={handleImageError}
          />
        ) : (
          <p className="photo-card-status photo-card-status--placeholder">{status}</p>
        )}
        {brokenVisible ? <p className="photo-card-broken">{IMAGE_BROKEN}</p> : null}
      </div>
      {displayPhoto.thumbUrl !== null ? (
        <p className="photo-card-status">{status}</p>
      ) : null}
      <p className="photo-card-meta">{formatByteSize(displayPhoto.byteSize)}</p>
      <p className="photo-card-meta">{formatLocalMinute(displayPhoto.createdAt)}</p>
      {showScore && score !== null ? (
        <p className="photo-card-score">{`相关度 ${formatScore(score)}`}</p>
      ) : null}
    </a>
  );
}
