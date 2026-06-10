import { defineConfig } from "prisma/config";

function resolveDatasourceUrl() {
  const configuredUrl = process.env.DATABASE_URL?.trim();
  if (
    configuredUrl?.startsWith("file:") ||
    configuredUrl?.startsWith("libsql:") ||
    configuredUrl?.startsWith("http://") ||
    configuredUrl?.startsWith("https://")
  ) {
    return configuredUrl;
  }

  return "file:./dev.db";
}

export default defineConfig({
  schema: "./prisma/schema.prisma",
  datasource: {
    url: resolveDatasourceUrl(),
  },
});
