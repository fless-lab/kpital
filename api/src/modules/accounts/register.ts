import type { Db } from "../../db/client";
import { accounts, wallets } from "../../db/schema";
import { hashPassword, isStrongPassword } from "../auth/password";

export class WeakPasswordError extends Error {}

export type RegisterInput = {
  email: string; phone?: string; password: string;
  firstName: string; lastName: string; country: string;
  roles: ("investor" | "porteur")[];
};

export async function registerAccount(db: Db, input: RegisterInput): Promise<{ accountId: string }> {
  if (!isStrongPassword(input.password)) throw new WeakPasswordError();
  const passwordHash = await hashPassword(input.password);
  return db.transaction(async (tx) => {
    const [acc] = await tx.insert(accounts).values({
      email: input.email, phone: input.phone, passwordHash,
      firstName: input.firstName, lastName: input.lastName,
      country: input.country, roles: input.roles.length ? input.roles : ["investor"],
    }).returning({ id: accounts.id });
    if (!acc) throw new Error("account insert returned no row");
    await tx.insert(wallets).values({ accountId: acc.id });
    return { accountId: acc.id };
  });
}
