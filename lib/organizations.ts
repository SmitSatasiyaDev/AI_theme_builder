import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import { organizations, organizationMembers } from "@/db/schema/organizations";

// Read-only membership queries. Kept out of lib/actions/organizations.ts on purpose: every
// export of a "use server" module becomes a client-callable server action, and these take an
// arbitrary userId — exposing them would let any client probe other users' memberships.

export async function getUserOrganizations(userId: string) {
  return db
    .select({ org: organizations, role: organizationMembers.role })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizationMembers.orgId, organizations.id))
    .where(eq(organizationMembers.userId, userId));
}

/** The user's membership in the org with this slug, or null if they aren't a member. */
export async function getOrgMembership(orgSlug: string, userId: string) {
  const [row] = await db
    .select({ org: organizations, role: organizationMembers.role })
    .from(organizations)
    .innerJoin(
      organizationMembers,
      and(eq(organizationMembers.orgId, organizations.id), eq(organizationMembers.userId, userId)),
    )
    .where(eq(organizations.slug, orgSlug))
    .limit(1);

  return row ?? null;
}

/** Whether the user belongs to the org with this id. */
export async function isOrgMember(orgId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ orgId: organizationMembers.orgId })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
    .limit(1);
  return rows.length > 0;
}
