import { pgTable, text, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { users } from "./auth";

export const organizations = pgTable("organization", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  ownerId: text("ownerId")
    .notNull()
    .references(() => users.id),
  plan: text("plan").notNull().default("free"),
  createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
});

export const organizationMembers = pgTable(
  "organization_member",
  {
    orgId: text("orgId")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "admin", "member"] })
      .notNull()
      .default("member"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);
