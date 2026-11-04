const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function photoObjectKey(userId: string, photoId: string): string {
  if (!UUID.test(userId) || !UUID.test(photoId)) {
    throw new Error("对象键标识不合法");
  }
  return `owners/${userId}/photos/${photoId}/original`;
}
