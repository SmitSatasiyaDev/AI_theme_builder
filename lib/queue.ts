import { PgBoss } from "pg-boss";
import { requireEnv } from "./env";

export const GENERATE_THEME_QUEUE = "generate-theme";

let bossPromise: Promise<PgBoss> | null = null;

export function getBoss(): Promise<PgBoss> {
  if (bossPromise) {
    return bossPromise;
  }

  const boss = new PgBoss(requireEnv("DATABASE_URL"));
  boss.on("error", (err: Error) => console.error("[pg-boss]", err));

  const promise = boss.start().then(async () => {
    await boss.createQueue(GENERATE_THEME_QUEUE);
    return boss;
  });
  bossPromise = promise;
  return promise;
}

export type GenerateThemeJobData = { jobId: string };
