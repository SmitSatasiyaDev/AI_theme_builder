import Link from "next/link";
import { auth } from "@/lib/auth";

export default async function LandingPage() {
  const session = await auth();

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between px-6 py-4 sm:px-10">
        <span className="text-lg font-semibold">AI Theme Studio</span>
        <nav className="flex items-center gap-4 text-sm">
          {session?.user ? (
            <Link href="/dashboard" className="rounded-md bg-black px-4 py-2 text-white">
              Go to dashboard
            </Link>
          ) : (
            <>
              <Link href="/sign-in" className="text-gray-700 hover:text-black">
                Sign in
              </Link>
              <Link href="/sign-up" className="rounded-md bg-black px-4 py-2 text-white">
                Get started
              </Link>
            </>
          )}
        </nav>
      </header>

      <main className="mx-auto flex max-w-3xl flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
          Generate and edit your Shopify theme with AI
        </h1>
        <p className="text-lg text-gray-600">
          Connect your store, describe what you want, and get a fully configured
          theme &mdash; then keep refining it conversationally.
        </p>
        <Link
          href={session?.user ? "/dashboard" : "/sign-up"}
          className="rounded-md bg-black px-6 py-3 text-white"
        >
          {session?.user ? "Go to dashboard" : "Start for free"}
        </Link>
      </main>
    </div>
  );
}
