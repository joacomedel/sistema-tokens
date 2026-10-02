import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const FORBIDDEN = /\b(insert|update|delete|drop|alter|attach|pragma|vacuum)\b/i;

/** Acepta solo una sentencia SELECT/WITH; agrega LIMIT si falta. */
export function guardSelect(sql, limit = 500) {
  const trimmed = String(sql ?? '').trim().replace(/;+\s*$/, '');
  if (!trimmed) throw new Error('empty SQL');
  if (trimmed.includes(';')) throw new Error('only a single statement is allowed');
  if (!/^\s*(select|with)\b/i.test(trimmed)) throw new Error('only SELECT/WITH queries are allowed');
  if (FORBIDDEN.test(trimmed)) throw new Error('write/DDL statements are not allowed');
  return /\blimit\b/i.test(trimmed) ? trimmed : `${trimmed} LIMIT ${limit}`;
}

/**
 * Acceso perezoso a la BD de OpenCode en modo read-only. `query` aplica los
 * guardrails de `guardSelect`; `available` indica si la BD está en disco.
 */
export function createDbAccess({ dbPath, enabled = true }) {
  let db = null;

  function open() {
    if (!db) db = new DatabaseSync(dbPath, { readOnly: true });
    return db;
  }

  return {
    available() {
      return enabled && existsSync(dbPath);
    },
    query(sql, { limit = 500 } = {}) {
      if (!enabled) throw new Error('database fallback is disabled');
      if (!existsSync(dbPath)) throw new Error(`OpenCode DB not found at ${dbPath}`);
      return open().prepare(guardSelect(sql, limit)).all();
    },
    close() {
      if (db) {
        db.close();
        db = null;
      }
    },
  };
}
