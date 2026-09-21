process.env.DATABASE_MODE='pglite'; process.env.PGLITE_DATA_DIR=':memory:';
const {runMigrations}=await import('./src/lib/migrate.ts');
const {getDb}=await import('./src/lib/db.ts');
const r=await runMigrations();
console.log('applied:', r.applied.join(', '));
const db=await getDb();
const t=await db.query<{table_name:string}>(
  `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`);
console.log('tables:', t.rows.length);
const cols=await db.query<{column_name:string}>(
  `SELECT column_name FROM information_schema.columns WHERE table_name='opportunities' AND column_name IN ('research_stage','validation_level','rank_score')`);
console.log('new opportunity cols:', cols.rows.map(c=>c.column_name).join(','));
console.log('rerun idempotent:', (await runMigrations()).applied.length===0 ? 'OK':'FAIL');
