import { useEffect, useState } from "react";
import { type Photo } from "../api";
import {
  formatByteSize,
  formatLocalMinute,
  formatScore,
  photoAlt,
  statusText,
} from "../copy";
import { IMAGE_BROKEN, usePhotoUrlRefresh } from "./photo-url-refresh";

type PhotoCardProps = {
  photo: Photo;
  score: number | null;
  showScore: boolean;
  onNavigate: (to: string, mode?: "push" | "replace") => void;
};

export function PhotoCard({ photo, score, showScore, onNavigate }: PhotoCardProps) {
  const [displayPhoto, setDisplayPhoto] = useState(photo);
  const [brokenVisible, setBrokenVisible] = useState(false);
  const { onImageError } = usePhotoUrlRefresh(displayPhoto, setDisplayPhoto, setBrokenVisible);

  useEffect(() => {
    setDisplayPhoto(photo);
  }, [photo]);

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
            onError={onImageError}
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
