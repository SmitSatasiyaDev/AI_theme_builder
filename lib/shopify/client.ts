import { eq } from "drizzle-orm";
import { db } from "@/db";
import { shopifyStores } from "@/db/schema/shopify";
import { decryptSecret } from "@/lib/crypto";

const API_VERSION = "2025-01";

export async function getStoreForOrg(orgId: string) {
  const [store] = await db
    .select()
    .from(shopifyStores)
    .where(eq(shopifyStores.orgId, orgId))
    .limit(1);
  return store ?? null;
}

async function shopifyGraphQL<T>(
  shopDomain: string,
  accessToken: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`https://${shopDomain}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`Shopify GraphQL request failed: ${res.status} ${await res.text()}`);
  }

  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (json.errors) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data as T;
}

const PRODUCTS_QUERY = `
  query Products($first: Int!) {
    products(first: $first) {
      edges {
        node {
          id
          title
          handle
          status
          featuredImage { url altText }
          variants(first: 1) {
            edges { node { id price } }
          }
        }
      }
    }
  }
`;

type ProductsResponse = {
  products: {
    edges: {
      node: {
        id: string;
        title: string;
        handle: string;
        status: string;
        featuredImage: { url: string; altText: string | null } | null;
        variants: { edges: { node: { id: string; price: string } }[] };
      };
    }[];
  };
};

export async function getProductsForOrg(orgId: string, first = 20) {
  const store = await getStoreForOrg(orgId);
  if (!store) {
    throw new Error("No Shopify store connected for this organization");
  }

  const accessToken = decryptSecret(store.accessTokenEncrypted);
  const data = await shopifyGraphQL<ProductsResponse>(store.shopDomain, accessToken, PRODUCTS_QUERY, {
    first,
  });

  return data.products.edges.map((edge) => edge.node);
}
