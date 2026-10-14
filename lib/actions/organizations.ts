"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { organizations, organizationMembers } from "@/db/schema/organizations";
import { auth } from "@/lib/auth";

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)+/g, "") || "org"
  );
}

async function slugExists(slug: string): Promise<boolean> {
  const rows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, slug))
    .limit(1);
  return rows.length > 0;
}

/** `baseSlug`, or `baseSlug-2`, `baseSlug-3`, ... — the first one not already taken. */
async function uniqueSlug(baseSlug: string): Promise<string> {
  let slug = baseSlug;
  for (let suffix = 2; await slugExists(slug); suffix++) {
    slug = `${baseSlug}-${suffix}`;
  }
  return slug;
}

export async function createOrganization(formData: FormData) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    redirect("/sign-in");
  }

  const name = String(formData.get("name") ?? "").trim();
  if (!name) {
    throw new Error("Organization name is required");
  }

  const slug = await uniqueSlug(slugify(name));

  const [org] = await db
    .insert(organizations)
    .values({ name, slug, ownerId: userId })
    .returning();

  await db.insert(organizationMembers).values({
    orgId: org.id,
    userId,
    role: "owner",
  });

  redirect(`/dashboard/${org.slug}`);
}
