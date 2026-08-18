"use server";

import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema/auth";

export type RegisterResult = { ok: true } | { ok: false; error: string };

export async function registerUser(input: {
  name: string;
  email: string;
  password: string;
}): Promise<RegisterResult> {
  const email = input.email.trim().toLowerCase();
  if (!email || !input.password || input.password.length < 8) {
    return { ok: false, error: "Enter a valid email and a password of at least 8 characters." };
  }

  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing) {
    return { ok: false, error: "An account with this email already exists." };
  }

  const passwordHash = await bcrypt.hash(input.password, 12);
  await db.insert(users).values({
    name: input.name.trim() || null,
    email,
    passwordHash,
  });

  return { ok: true };
}
