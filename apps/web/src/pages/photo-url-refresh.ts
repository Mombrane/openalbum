import { useEffect, useRef } from "react";
import { api, type Photo } from "../api";

export const IMAGE_BROKEN = "图片暂时无法显示";
export const REFRESH_LEAD_MS = 60_000;

export function refreshAtMs(photo: Photo): number | null {
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

export function usePhotoUrlRefresh(
  displayPhoto: Photo,
  setDisplayPhoto: (photo: Photo) => void,
  setBrokenVisible: (visible: boolean) => void,
): { onImageError: () => void } {
  const errorRetriesRef = useRef(0);

  useEffect(() => {
    setBrokenVisible(false);
    errorRetriesRef.current = 0;
  }, [displayPhoto.id, setBrokenVisible]);

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
  }, [displayPhoto.id, displayPhoto.originalUrlExpiresAt, displayPhoto.thumbUrlExpiresAt]);

  const onImageError = () => {
    if (errorRetriesRef.current === 0) {
      errorRetriesRef.current = 1;
      refreshOnce(displayPhoto.id);
      return;
    }
    setBrokenVisible(true);
  };

  return { onImageError };
}
