import { PgBoss } from "pg-boss";

export const GENERATE_THEME_QUEUE = "generate-theme";

let bossPromise: Promise<PgBoss> | null = null;

export function getBoss(): Promise<PgBoss> {
  if (bossPromise) {
    return bossPromise;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  const boss = new PgBoss(connectionString);
  boss.on("error", (err: Error) => console.error("[pg-boss]", err));

  const promise = boss.start().then(async () => {
    await boss.createQueue(GENERATE_THEME_QUEUE);
    return boss;
  });
  bossPromise = promise;
  return promise;
}

export type GenerateThemeJobData = { jobId: string };
