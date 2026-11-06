export function parseExifTimestamp(raw: unknown, offsetRaw: unknown): Date | null {
  if (typeof raw !== "string") return null;
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw);
  if (!match) return null;
  const year = Number(match[1]);
  if (year < 1970 || year > 2100) return null;
  const offset = typeof offsetRaw === "string" && /^[+-]\d{2}:\d{2}$/.test(offsetRaw.trim()) ? offsetRaw.trim() : "Z";
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${offset}`;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

export function parseGpsPair(latitude: unknown, longitude: unknown): { latitude: number | null; longitude: number | null } {
  if (typeof latitude !== "number" || typeof longitude !== "number" || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { latitude: null, longitude: null };
  }
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return { latitude: null, longitude: null };
  }
  return { latitude, longitude };
}
