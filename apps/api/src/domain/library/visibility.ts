export function isVisiblePhoto(photo: { ownerId: string } | null, userId: string): boolean {
  return photo !== null && photo.ownerId === userId;
}
