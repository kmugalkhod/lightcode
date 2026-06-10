import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "../generated/prisma/client";
import { initializeLocalDatabase, resolveDatabaseUrl } from "./local-database";

export const databaseUrl = resolveDatabaseUrl();
initializeLocalDatabase(databaseUrl);

declare global {
  var __lightcodePrismaClient: PrismaClient | undefined;
}

function createPrismaClient() {
  const adapter = new PrismaLibSql({ url: databaseUrl });
  return new PrismaClient({ adapter });
}

export const prisma =
  globalThis.__lightcodePrismaClient ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__lightcodePrismaClient = prisma;
}
