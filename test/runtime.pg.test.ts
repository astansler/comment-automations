import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe } from 'vitest';
import { createPgStore, migrate } from '../src/store/pg.js';
import { runtimeScenarios } from './runtime.scenarios.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('postgres runtime', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  });
  afterAll(async () => {
    await pool.end();
  });

  // A store in its own new schema, so test files can run in parallel and reruns start clean.
  runtimeScenarios('postgres', async () => {
    const schema = `runtime_test_${randomUUID().replaceAll('-', '')}`;
    await migrate(pool, { schema });
    return {
      store: createPgStore(pool, { schema }),
      cleanup: async () => {
        await pool.query(`DROP SCHEMA ${pg.escapeIdentifier(schema)} CASCADE`);
      },
    };
  });
});
