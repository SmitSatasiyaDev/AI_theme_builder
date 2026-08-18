import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { getUserOrganizations, createOrganization } from "@/lib/actions/organizations";

export default async function DashboardIndexPage() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    redirect("/sign-in");
  }

  const memberships = await getUserOrganizations(userId);

  if (memberships.length === 1) {
    redirect(`/dashboard/${memberships[0].org.slug}`);
  }

  return (
    <div className="mx-auto flex max-w-lg flex-1 flex-col justify-center gap-8 px-6 py-16">
      {memberships.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-gray-500">Your organizations</h2>
          {memberships.map(({ org }) => (
            <Link
              key={org.id}
              href={`/dashboard/${org.slug}`}
              className="rounded-md border border-gray-200 px-4 py-3 hover:border-black"
            >
              {org.name}
            </Link>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-gray-500">
          {memberships.length > 0 ? "Create another organization" : "Create your organization"}
        </h2>
        <form action={createOrganization} className="flex gap-2">
          <input
            name="name"
            required
            placeholder="Acme Inc."
            className="flex-1 rounded-md border border-gray-300 px-3 py-2"
          />
          <button type="submit" className="rounded-md bg-black px-4 py-2 text-white">
            Create
          </button>
        </form>
      </div>
    </div>
  );
}
