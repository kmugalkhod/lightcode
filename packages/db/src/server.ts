import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is required to initialize Prisma Client.");
}

const adapter = new PrismaPg({ connectionString });

declare global {
  var __lightcodePrismaClient: PrismaClient | undefined;
}

function createPrismaClient() {
  return new PrismaClient({ adapter });
}

export const prisma =
  globalThis.__lightcodePrismaClient ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__lightcodePrismaClient = prisma;
}
