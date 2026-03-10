#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { applySurqlSchema } from "./index.js";

type MigrationModule = {
  default?: unknown;
  auth?: { options?: unknown };
  db?: unknown;
};

const printUsage = () => {
  console.error(
    [
      "Usage:",
      "  surrealdb-better-auth migrate --config <path> [--auth auth] [--db db] [--file better-auth-schema.surql]",
      "",
      "The config module must export a Better Auth instance and a connected Surreal client.",
    ].join("\n"),
  );
};

const parseArgs = (argv: string[]) => {
  const args = argv.slice(2);
  const command = args[0];
  let config: string | undefined;
  let authExport = "auth";
  let dbExport = "db";
  let file: string | undefined;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--config") {
      config = args[++i];
    } else if (arg === "--auth") {
      authExport = args[++i] ?? authExport;
    } else if (arg === "--db") {
      dbExport = args[++i] ?? dbExport;
    } else if (arg === "--file") {
      file = args[++i];
    }
  }

  return { command, config, authExport, dbExport, file };
};

const resolveExport = <T>(mod: MigrationModule, key: string): T | undefined => {
  const direct = mod[key as keyof MigrationModule] as T | undefined;
  if (direct !== undefined) return direct;

  if (mod.default && typeof mod.default === "object") {
    return (mod.default as Record<string, T | undefined>)[key];
  }

  return undefined;
};

const main = async () => {
  const { command, config, authExport, dbExport, file } = parseArgs(process.argv);

  if (command !== "migrate" || !config) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const absoluteConfig = resolve(process.cwd(), config);
  const mod = (await import(pathToFileURL(absoluteConfig).href)) as MigrationModule;

  const auth = resolveExport<{ options?: unknown }>(mod, authExport);
  const db = resolveExport<{ close?: () => Promise<void> }>(mod, dbExport);

  if (!auth?.options) {
    throw new Error(`Could not find a Better Auth instance export named "${authExport}".`);
  }

  if (!db || typeof db !== "object") {
    throw new Error(`Could not find a Surreal client export named "${dbExport}".`);
  }

  const result = await applySurqlSchema({
    db: db as never,
    authOptions: auth.options as never,
    file,
  });

  console.log(`Applied SurrealDB schema${result.path ? ` (${result.path})` : ""}.`);

  if (typeof db.close === "function") {
    await db.close();
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
