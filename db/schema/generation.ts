import { pgTable, text, timestamp, jsonb, integer, primaryKey } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { shopifyStores } from "./shopify";
import { users } from "./auth";

export const generationJobs = pgTable("generation_job", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  orgId: text("orgId")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  storeId: text("storeId")
    .notNull()
    .references(() => shopifyStores.id, { onDelete: "cascade" }),
  userId: text("userId")
    .notNull()
    .references(() => users.id),
  type: text("type", {
    enum: ["initial_generation", "targeted_edit", "apply"],
  }).notNull(),
  status: text("status", {
    enum: ["queued", "running", "completed", "failed"],
  })
    .notNull()
    .default("queued"),
  inputPrompt: text("inputPrompt"),
  resultJson: jsonb("resultJson"),
  errorMessage: text("errorMessage"),
  createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  completedAt: timestamp("completedAt", { mode: "date" }),
});

export const themeStates = pgTable(
  "theme_state",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    storeId: text("storeId")
      .notNull()
      .references(() => shopifyStores.id, { onDelete: "cascade" }),
    themeId: text("themeId").notNull(),
    snapshotJson: jsonb("snapshotJson").notNull(),
    version: integer("version").notNull().default(1),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.storeId, t.themeId] })],
);

export const conversationSessions = pgTable("conversation_session", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  storeId: text("storeId")
    .notNull()
    .references(() => shopifyStores.id, { onDelete: "cascade" }),
  userId: text("userId")
    .notNull()
    .references(() => users.id),
  status: text("status").notNull().default("active"),
  turnsJson: jsonb("turnsJson").notNull().default([]),
  themeStateVersion: integer("themeStateVersion"),
  createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).notNull().defaultNow(),
});

export const briefs = pgTable("brief", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  sessionId: text("sessionId")
    .notNull()
    .references(() => conversationSessions.id, { onDelete: "cascade" }),
  briefJson: jsonb("briefJson").notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).notNull().defaultNow(),
});

export const usageCounters = pgTable(
  "usage_counter",
  {
    orgId: text("orgId")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    period: text("period").notNull(),
    generationsUsed: integer("generationsUsed").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.period] })],
);
