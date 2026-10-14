// `pnpm db:local` — talk to the DATABASE_URL Postgres straight from the
// terminal, without needing drizzle-studio or a GUI client.
//
//   pnpm db:local                          interactive shell
//   pnpm db:local "select * from users"    run one query and exit
//   pnpm db:local -f db/migrations/x.sql   run a .sql file
//   echo "select 1" | pnpm db:local        run SQL piped on stdin
//
// Unlike scripts/worker.ts this file can use normal ESM imports: nothing it
// imports reads process.env at module-eval time, so the hoisting hazard
// documented over there (env loaded after `db/index.ts` already connected)
// doesn't apply. DATABASE_URL is only read inside main(), after loadEnvFile().
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import postgres from "postgres";
import type { Sql } from "postgres";
import { errorMessage } from "../lib/errors";

try {
  // Same as the worker: Node's built-in loader reads .env only, not .env.local.
  process.loadEnvFile();
} catch {
  // no .env file present in cwd — assume the environment is already set
}

const HELP = `pnpm db:local — Postgres shell for DATABASE_URL

  pnpm db:local                        open an interactive shell
  pnpm db:local "<sql>"                run SQL and exit
  pnpm db:local -f <file.sql>          run a .sql file and exit
  cat q.sql | pnpm db:local            run SQL from stdin

In the interactive shell:
  <sql>;      run a statement (statements end at a ';')
  \\dt         list tables
  \\d <table>  describe a table
  \\?          this help
  \\q          quit  (Ctrl-D works too)

Several statements separated by ';' run as one batch. They all execute, but
Postgres reports back per row-returning statement, so plain DDL/DML lines in
a batch may not print a result tag of their own.`;

const LIST_TABLES = `select table_schema as schema, table_name as "table"
  from information_schema.tables
  where table_schema not in ('pg_catalog', 'information_schema')
  order by 1, 2`;

const describeTable = (name: string) => `select column_name as "column",
    data_type as type,
    is_nullable as nullable,
    column_default as "default"
  from information_schema.columns
  where table_name = '${name.replace(/'/g, "''")}'
  order by ordinal_position`;

/** Print whatever `sql.unsafe(...).simple()` handed back. */
function printResult(result: unknown): void {
  // A multi-statement simple query resolves to an array of result sets.
  // (Length matters: a 0-row result is an empty array, which would otherwise
  // look like an empty list of result sets and print nothing at all.)
  if (Array.isArray(result) && result.length > 0 && result.every(Array.isArray)) {
    for (const one of result) printResult(one);
    return;
  }
  const rows = result as Array<Record<string, unknown>> & {
    command?: string;
    count?: number;
  };
  if (rows.length === 0) {
    // A SELECT that matched nothing, versus INSERT/UPDATE/DELETE/DDL, which
    // never return rows and are better reported by command + affected count.
    console.log(
      rows.command === "SELECT" || !rows.command
        ? "(0 rows)"
        : `${rows.command}${rows.count ? ` ${rows.count}` : ""}`,
    );
    return;
  }
  console.table(rows);
  console.log(`(${rows.length} row${rows.length === 1 ? "" : "s"})`);
}

async function run(sql: Sql, query: string): Promise<void> {
  printResult(await sql.unsafe(query).simple());
}

/** Expand the psql-style backslash shortcuts; returns null for "\q". */
function expandMetaCommand(line: string): string | null {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  const arg = rest.join(" ");
  if (cmd === "\\q" || cmd === "\\quit" || cmd === "\\exit") return null;
  if (cmd === "\\dt") return LIST_TABLES;
  if (cmd === "\\d") return arg ? describeTable(arg) : LIST_TABLES;
  console.log(HELP);
  return "";
}

/**
 * Built-in shell, used when psql isn't on PATH. Buffers input until a ';' so
 * multi-line statements can be pasted; backslash commands fire immediately.
 */
async function repl(sql: Sql, url: string): Promise<void> {
  // postgres.js connects lazily, so dial once up front: an unreachable
  // database should fail here, not after the first statement is typed.
  await sql`select 1`;
  console.log(`connected to ${redact(url)} — \\? for help, \\q to quit`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let buffer = "";
  const prompt = () => rl.setPrompt(buffer ? "  ...> " : "db=> ");

  prompt();
  rl.prompt();
  for await (const line of rl) {
    let query = "";
    if (!buffer && line.trim().startsWith("\\")) {
      const expanded = expandMetaCommand(line);
      if (expanded === null) break;
      query = expanded;
    } else {
      buffer += `${line}\n`;
      if (!line.trimEnd().endsWith(";")) {
        prompt();
        rl.prompt();
        continue;
      }
      query = buffer;
      buffer = "";
    }
    if (query.trim()) {
      try {
        await run(sql, query);
      } catch (error) {
        console.error(errorMessage(error));
      }
    }
    prompt();
    rl.prompt();
  }
  rl.close();
}

/** Hide the password when echoing the connection string back to the user. */
const redact = (url: string) => url.replace(/:\/\/([^:@/]+):[^@]*@/, "://$1:****@");

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args[0] === "-h" || args[0] === "--help") {
    console.log(HELP);
    return 0;
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set (expected in .env — see .env.example)");
    return 1;
  }

  let query = "";
  if (args[0] === "-f" || args[0] === "--file") {
    if (!args[1]) {
      console.error("-f needs a path to a .sql file");
      return 1;
    }
    query = readFileSync(args[1], "utf8");
  } else if (args.length > 0) {
    query = args.join(" ");
  } else if (!process.stdin.isTTY) {
    query = await readStdin();
  }

  // No query and a real terminal: hand over to psql when it's installed —
  // it has history, tab completion and pagers this script won't reimplement.
  if (!query.trim()) {
    const psql = spawnSync("psql", [url], { stdio: "inherit" });
    if (!psql.error) return psql.status ?? 0;
  }

  const sql = postgres(url, { max: 1, onnotice: (notice) => console.log(notice.message) });
  try {
    if (query.trim()) {
      await run(sql, query);
    } else {
      await repl(sql, url);
    }
    return 0;
  } catch (error) {
    console.error(errorMessage(error));
    return 1;
  } finally {
    await sql.end();
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
