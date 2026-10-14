import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { requireOrgMembership } from "@/lib/organizations";

export default async function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ org: string }>;
}) {
  const { org: orgSlug } = await params;
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    redirect("/sign-in");
  }

  const membership = await requireOrgMembership(orgSlug, userId);
  if (!membership) {
    notFound();
  }

  const nav = [
    { href: `/dashboard/${orgSlug}`, label: "Overview" },
    { href: `/dashboard/${orgSlug}/stores`, label: "Stores" },
    { href: `/dashboard/${orgSlug}/generate`, label: "Theme" },
    { href: `/dashboard/${orgSlug}/settings`, label: "Settings" },
  ];

  return (
    <div className="flex flex-1">
      <aside className="flex w-56 flex-col gap-1 border-r border-gray-200 p-4">
        <p className="mb-4 truncate text-sm font-semibold">{membership.org.name}</p>
        {nav.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="rounded-md px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
          >
            {item.label}
          </Link>
        ))}
      </aside>
      <main className="flex-1 p-8">{children}</main>
    </div>
  );
}
