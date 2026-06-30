import { getTableConfig } from 'drizzle-orm/pg-core';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';

export function column(table: PgTable, dbName: string): AnyPgColumn {
  const found = getTableConfig(table).columns.find((c) => c.name === dbName);
  if (!found) {
    throw new Error(`column ${dbName} not found on ${getTableConfig(table).name}`);
  }
  return found;
}

export interface IndexShape {
  name: string | undefined;
  unique: boolean;
  partial: boolean;
  columns: string[];
}

export function indexShapes(table: PgTable): IndexShape[] {
  return getTableConfig(table).indexes.map((index) => ({
    name: index.config.name,
    unique: index.config.unique,
    partial: index.config.where !== undefined,
    columns: index.config.columns.map((c) => ('name' in c ? (c as { name: string }).name : '')),
  }));
}

export function findIndex(table: PgTable, name: string): IndexShape {
  const found = indexShapes(table).find((index) => index.name === name);
  if (!found) {
    throw new Error(`index ${name} not found on ${getTableConfig(table).name}`);
  }
  return found;
}

export interface UniqueShape {
  name: string | undefined;
  columns: string[];
}

export function uniqueShapes(table: PgTable): UniqueShape[] {
  return getTableConfig(table).uniqueConstraints.map((u) => ({
    name: u.name,
    columns: u.columns.map((c) => c.name),
  }));
}

export interface ForeignKeyShape {
  columns: string[];
  foreignTable: string;
  foreignColumns: string[];
  onDelete: string | undefined;
}

export function foreignKeyShapes(table: PgTable): ForeignKeyShape[] {
  return getTableConfig(table).foreignKeys.map((fk) => {
    const ref = fk.reference();
    return {
      columns: ref.columns.map((c) => c.name),
      foreignTable: getTableConfig(ref.foreignTable).name,
      foreignColumns: ref.foreignColumns.map((c) => c.name),
      onDelete: fk.onDelete,
    };
  });
}

export function findForeignKey(table: PgTable, localColumns: string[]): ForeignKeyShape {
  const found = foreignKeyShapes(table).find(
    (fk) =>
      fk.columns.length === localColumns.length && localColumns.every((c) => fk.columns.includes(c))
  );
  if (!found) {
    throw new Error(
      `foreign key on (${localColumns.join(', ')}) not found on ${getTableConfig(table).name}`
    );
  }
  return found;
}

export function checkNames(table: PgTable): string[] {
  return getTableConfig(table).checks.map((c) => c.name);
}

/** True when the column has a SQL-side default expression (e.g. uuidv7()). */
export function hasDefault(table: PgTable, dbName: string): boolean {
  const c = column(table, dbName);
  return c.default !== undefined || c.defaultFn !== undefined || c.hasDefault;
}
