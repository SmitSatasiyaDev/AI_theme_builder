import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

export const shopifyStores = pgTable("shopify_store", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  orgId: text("orgId")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  shopDomain: text("shopDomain").notNull().unique(),
  accessTokenEncrypted: text("accessTokenEncrypted").notNull(),
  scopes: text("scopes").notNull(),
  activeThemeId: text("activeThemeId"),
  installedAt: timestamp("installedAt", { mode: "date" }).notNull().defaultNow(),
  uninstalledAt: timestamp("uninstalledAt", { mode: "date" }),
});
