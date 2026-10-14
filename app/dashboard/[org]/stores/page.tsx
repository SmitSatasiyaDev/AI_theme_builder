import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getOrgMembership } from "@/lib/organizations";
import { getStoreForOrg, getProductsForOrg } from "@/lib/shopify/client";
import { SHOP_DOMAIN_PATTERN } from "@/lib/shopify/shop-domain";

export default async function StoresPage({ params }: { params: Promise<{ org: string }> }) {
  const { org: orgSlug } = await params;
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    redirect("/sign-in");
  }

  const membership = await getOrgMembership(orgSlug, userId);
  if (!membership) {
    redirect("/dashboard");
  }

  const store = await getStoreForOrg(membership.org.id);
  const products = store ? await getProductsForOrg(membership.org.id).catch(() => null) : null;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Stores</h1>

      {!store ? (
        <form action="/api/shopify/install" method="get" className="flex gap-2">
          <input type="hidden" name="org" value={orgSlug} />
          <input
            name="shop"
            placeholder="your-store.myshopify.com"
            required
            pattern={SHOP_DOMAIN_PATTERN}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
          <button type="submit" className="rounded-md bg-black px-4 py-2 text-sm text-white">
            Connect store
          </button>
        </form>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-gray-600">Connected: {store.shopDomain}</p>
          {products ? (
            <ul className="grid grid-cols-2 gap-4 md:grid-cols-3">
              {products.map((product) => (
                <li key={product.id} className="rounded-md border border-gray-200 p-3 text-sm">
                  {product.title}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-red-600">Could not load products.</p>
          )}
        </div>
      )}
    </div>
  );
}
