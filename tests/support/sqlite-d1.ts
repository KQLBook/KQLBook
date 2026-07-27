import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

type SqliteValue = string | number | bigint | Uint8Array | null;

interface SqliteRunResult {
	changes: number;
	lastInsertRowid: number | bigint;
}

interface SqliteStatement {
	all(...values: SqliteValue[]): Array<Record<string, unknown>>;
	get(...values: SqliteValue[]): Record<string, unknown> | undefined;
	run(...values: SqliteValue[]): SqliteRunResult;
}

interface SqliteDatabase {
	close(): void;
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
}

interface SqliteModule {
	DatabaseSync: new (path: string) => SqliteDatabase;
}

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as SqliteModule;

function meta(changes = 0) {
	return {
		changes,
		duration: 0,
		last_row_id: 0,
		changed_db: changes > 0,
		size_after: 0,
		rows_read: 0,
		rows_written: changes,
	};
}

class TestD1Statement {
	readonly #database: SqliteDatabase;
	readonly #sql: string;
	readonly #values: SqliteValue[];

	constructor(
		database: SqliteDatabase,
		sql: string,
		values: SqliteValue[] = [],
	) {
		this.#database = database;
		this.#sql = sql;
		this.#values = values;
	}

	bind(...values: unknown[]): TestD1Statement {
		return new TestD1Statement(
			this.#database,
			this.#sql,
			values as SqliteValue[],
		);
	}

	async first<T = Record<string, unknown>>(
		columnName?: string,
	): Promise<T | null> {
		const row = this.#database.prepare(this.#sql).get(...this.#values);
		if (!row) {
			return null;
		}
		return (columnName ? row[columnName] : row) as T;
	}

	async all<T = Record<string, unknown>>() {
		const results = this.#database.prepare(this.#sql).all(...this.#values) as T[];
		return {
			success: true,
			results,
			meta: meta(),
		};
	}

	async run() {
		const result = this.#database.prepare(this.#sql).run(...this.#values);
		return {
			success: true,
			results: [],
			meta: {
				...meta(result.changes),
				last_row_id: Number(result.lastInsertRowid),
			},
		};
	}
}

export class TestD1Database {
	readonly #database: SqliteDatabase;

	constructor() {
		this.#database = new DatabaseSync(":memory:");
		const migrationsDirectory = new URL("../../migrations/", import.meta.url);
		const migrations = readdirSync(migrationsDirectory, {
			withFileTypes: true,
		})
			.filter(
				(entry) =>
					entry.isFile() && /^\d+_.+\.sql$/u.test(entry.name),
			)
			.map((entry) => entry.name)
			.sort();
		for (const migration of migrations) {
			this.#database.exec(
				readFileSync(new URL(migration, migrationsDirectory), "utf8"),
			);
		}
	}

	prepare(sql: string): TestD1Statement {
		return new TestD1Statement(this.#database, sql);
	}

	async batch(statements: TestD1Statement[]) {
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			const results = [];
			for (const statement of statements) {
				results.push(await statement.run());
			}
			this.#database.exec("COMMIT");
			return results;
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	close(): void {
		this.#database.close();
	}
}
