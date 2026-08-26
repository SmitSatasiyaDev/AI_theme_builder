import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireOrgMembership } from "@/lib/actions/organizations";
import { getRepresentativeProductForOrg, getStoreForOrg, type ShopifyPreviewProduct } from "@/lib/shopify/client";
import { decryptSecret } from "@/lib/crypto";
import { getAsset, getMainThemeId } from "@/lib/ai-schema/local-theme-fs";
import { renderTemplate } from "@/lib/preview/template-renderer";
import { createLocalThemeReader } from "@/lib/preview/fs-template-reader";
import type { GenerationConfig } from "@/lib/ai-schema/types";

/**
 * Best-effort: sections/blocks that read `product` (price, gallery, buy buttons, "only intended
 * for product pages" guards) shouldn't blank the whole preview just because the store has no
 * products yet or the Admin API hiccups — they fall back to their empty-state branch instead.
 */
async function resolvePreviewProduct(orgId: string): Promise<ShopifyPreviewProduct | null> {
  try {
    return await getRepresentativeProductForOrg(orgId);
  } catch {
    return null;
  }
}

function isGenerationConfig(value: unknown): value is GenerationConfig {
    if (!value || typeof value !== "object") return false;
    const v = value as Partial<GenerationConfig>;
    return typeof v.sections === "object" && v.sections !== null && Array.isArray(v.order);
}

async function resolveStore(orgSlug: string | undefined, userId: string) {
    if (!orgSlug) return { error: NextResponse.json({ error: "org is required" }, { status: 400 }) } as const;
    const membership = await requireOrgMembership(orgSlug, userId);
    if (!membership) {
        return { error: NextResponse.json({ error: "Not a member of this organization" }, { status: 403 }) } as const;
    }
    const store = await getStoreForOrg(membership.org.id);
    if (!store) {
        return { error: NextResponse.json({ error: "Connect a Shopify store first" }, { status: 400 }) } as const;
    }
    return { store } as const;
}

/**
 * Renders a template through the ported Liquid engine (lib/preview/template-renderer.ts) and
 * returns HTML for the preview iframe (components/preview-frame.tsx) to display via srcDoc.
 *
 * GET  ?org=<slug>&template=index — renders whatever is currently on disk at
 *      LOCAL_THEME_ROOT/templates/<template>.json (i.e. what's actually applied).
 * POST { org, config, templateName? } — renders an explicit candidate config instead, e.g. a
 *      just-completed generation job's proposed result, before the merchant has applied it.
 */
export async function GET(req: NextRequest) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const orgSlug = searchParams.get("org") ?? undefined;
    const templateName = searchParams.get("template") || "index";

    const resolved = await resolveStore(orgSlug, userId);
    if ("error" in resolved) return resolved.error;
    const { store } = resolved;

    const accessToken = decryptSecret(store.accessTokenEncrypted);
    const themeId = store.activeThemeId ?? (await getMainThemeId());

    const asset = await getAsset(store.shopDomain, accessToken, themeId, `templates/${templateName}.json`);
    if (!asset) {
        return NextResponse.json({ html: null, empty: true }, { status: 200 });
    }

    let config: GenerationConfig;
    try {
        config = JSON.parse(asset.value);
    } catch {
        return NextResponse.json({ error: `templates/${templateName}.json is not valid JSON` }, { status: 500 });
    }

    const product = await resolvePreviewProduct(store.orgId);
    const html = await renderTemplate({
        config,
        storeName: store.shopDomain,
        templateName,
        readTemplate: createLocalThemeReader(),
        product
    });
    return NextResponse.json({ html, empty: false });
}

export async function POST(req: NextRequest) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

    const body = await req.json().catch(() => null);
    const orgSlug = body?.org as string | undefined;
    const templateName = (body?.templateName as string | undefined) || "index";
    const config = body?.config;

    if (!isGenerationConfig(config)) {
        return NextResponse.json({ error: "config ({ sections, order }) is required" }, { status: 400 });
    }

    const resolved = await resolveStore(orgSlug, userId);
    if ("error" in resolved) return resolved.error;
    const { store } = resolved;

    const product = await resolvePreviewProduct(store.orgId);
    const html = await renderTemplate({
        config,
        storeName: store.shopDomain,
        templateName,
        readTemplate: createLocalThemeReader(),
        product
    });
    return NextResponse.json({ html, empty: false });
}
