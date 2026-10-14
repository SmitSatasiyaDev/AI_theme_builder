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

  const baseSlug = slugify(name);
  let slug = baseSlug;
  let suffix = 1;
  while (await db.select().from(organizations).where(eq(organizations.slug, slug)).limit(1).then((r) => r.length > 0)) {
    suffix += 1;
    slug = `${baseSlug}-${suffix}`;
  }

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
