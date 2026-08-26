import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { getThemeRoot } from "@/lib/ai-schema/local-theme-fs";

// Serves the theme checkout's own static files (assets/*, images/*) so the Liquid preview
// renderer's asset_url/image_url filters (lib/shopify-compat/filters.ts) resolve to something
// the browser can fetch. LOCAL_THEME_ROOT lives outside this app's public/ dir (it's a
// standalone theme checkout, not vendored in-repo like Shopforge's public/base-theme), so it
// needs a route rather than static file serving. No auth: these are generic vendored theme
// files (CSS, JS, demo images, fonts) — not per-tenant or otherwise sensitive data.

const CONTENT_TYPES: Record<string, string> = {
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".ico": "image/x-icon"
};

export async function GET(
    _req: NextRequest,
    { params }: { params: Promise<{ path: string[] }> }
) {
    const { path: segments } = await params;
    const relative = segments.join("/");

    let root: string;
    try {
        root = await getThemeRoot();
    } catch (error) {
        return NextResponse.json({ error: (error as Error).message }, { status: 500 });
    }

    const resolved = path.resolve(root, relative);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        return NextResponse.json({ error: "Invalid asset path" }, { status: 400 });
    }

    let data: Buffer;
    try {
        data = await fs.readFile(resolved);
    } catch {
        return NextResponse.json({ error: "Asset not found" }, { status: 404 });
    }

    const ext = path.extname(resolved).toLowerCase();
    return new NextResponse(new Uint8Array(data), {
        headers: {
            "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream",
            "Cache-Control": "public, max-age=3600"
        }
    });
}
