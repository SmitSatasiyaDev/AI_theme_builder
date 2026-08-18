import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { requireOrgMembership } from "@/lib/actions/organizations";
import { getStoreForOrg } from "@/lib/shopify/client";
import { EditChatPanel } from "@/components/edit-chat-panel";

export default async function EditPage({ params }: { params: Promise<{ org: string }> }) {
  const { org: orgSlug } = await params;
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    redirect("/sign-in");
  }

  const membership = await requireOrgMembership(orgSlug, userId);
  if (!membership) {
    redirect("/dashboard");
  }

  const store = await getStoreForOrg(membership.org.id);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Edit</h1>

      {!store ? (
        <p className="text-gray-600">
          Connect a Shopify store first —{" "}
          <Link href={`/dashboard/${orgSlug}/stores`} className="font-medium text-black underline">
            go to Stores
          </Link>
          .
        </p>
      ) : (
        <EditChatPanel orgSlug={orgSlug} />
      )}
    </div>
  );
}
