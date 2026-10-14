import { NextResponse } from "next/server";

/** The `{ error }` JSON body every API route returns on failure. */
export function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}
