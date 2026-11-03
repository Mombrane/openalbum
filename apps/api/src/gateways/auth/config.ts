export type AuthConfig = {
  jwtSecret: string;
  pepper: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  databaseUrl: string;
};

const DURATION = /^([1-9][0-9]*)(s|m|d)$/;

export function parseDurationSeconds(value: string): number {
  const match = DURATION.exec(value);
  if (!match) {
    throw new Error(`时长无效：${value}`);
  }
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === "s") return amount;
  if (unit === "m") return amount * 60;
  return amount * 86_400;
}

export function loadAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
  return {
    jwtSecret: requiredSecret(env.JWT_SECRET, "JWT_SECRET"),
    pepper: requiredSecret(env.API_KEY_PEPPER, "API_KEY_PEPPER"),
    accessTtlSeconds: parseDurationSeconds(env.JWT_TTL?.trim() || "15m"),
    refreshTtlSeconds: parseDurationSeconds(env.REFRESH_TTL?.trim() || "30d"),
    databaseUrl: requiredDatabaseUrl(env.DATABASE_URL),
  };
}

function requiredSecret(value: string | undefined, name: string): string {
  if (value === undefined || Buffer.byteLength(value, "utf8") < 32) {
    throw new Error(`${name} 缺失或短于 32 字节`);
  }
  return value;
}

function requiredDatabaseUrl(value: string | undefined): string {
  const databaseUrl = value?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL 缺失");
  }
  return databaseUrl;
}
