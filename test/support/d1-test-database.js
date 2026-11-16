import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import { authenticatedEnv, getTestAuth } from "./access-test-auth.js";

const migrationsDirectory = new URL("../../migrations/", import.meta.url);

class D1PreparedStatement {
  constructor(statement, values = []) {
    this.statement = statement;
    this.values = values;
  }

  bind(...values) {
    return new D1PreparedStatement(this.statement, values);
  }

  async first() {
    return this.statement.get(...this.values) ?? null;
  }

  async all() {
    return {
      success: true,
      results: this.statement.all(...this.values)
    };
  }

  async run() {
    const result = this.statement.run(...this.values);
    return {
      success: true,
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid)
      }
    };
  }
}

class D1DatabaseAdapter {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new D1PreparedStatement(this.database.prepare(sql));
  }
}

export async function createTestDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");

  const migrations = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();

  for (const migration of migrations) {
    database.exec(await readFile(new URL(migration, migrationsDirectory), "utf8"));
  }

  const auth = await getTestAuth();
  return {
    database,
    env: await authenticatedEnv({
      TEST_DATABASE: "tangled-woods-test-db",
      DB: new D1DatabaseAdapter(database)
    }),
    accessToken: auth.validToken,
    close() {
      database.close();
    }
  };
}

export function insertRabbit(database, rabbit) {
  database.prepare(
    "INSERT INTO rabbits (id, name, sex, data) VALUES (?, ?, ?, ?)"
  ).run(rabbit._id, rabbit.Name, rabbit.Sex, JSON.stringify(rabbit));
}

