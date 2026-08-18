import Link from "next/link";
import { signOut } from "@/lib/auth";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-gray-200 px-6 py-3">
        <Link href="/dashboard" className="text-sm font-semibold">
          AI Theme Studio
        </Link>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/" });
          }}
        >
          <button type="submit" className="text-sm text-gray-500 hover:text-black">
            Sign out
          </button>
        </form>
      </header>
      <div className="flex flex-1">{children}</div>
    </div>
  );
}
