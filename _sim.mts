process.env.DATABASE_MODE='pglite'; process.env.PGLITE_DATA_DIR=':memory:'; process.env.LOG_LEVEL='error';
process.env.AUTONOMY_ENABLED='true'; process.env.OUTREACH_ENABLED='true'; process.env.AUTO_START='true';
process.env.PUBLIC_BASE_URL='https://sim.example.com'; process.env.SENDER_COMPANY='S';
process.env.SENDER_EMAIL='f@sim.example.com'; process.env.SENDER_POSTAL_ADDRESS='1 Way';
process.env.SENDING_DOMAIN='sim.example.com'; process.env.OWNER_NAME='O';
process.env.OWNER_NOTIFICATION_EMAIL='o@sim.example.com'; process.env.UNSUBSCRIBE_SECRET='u'.repeat(32);
process.env.ADMIN_TOKEN='a'.repeat(32); process.env.CRON_SECRET='c'.repeat(32);
process.env.RESEND_API_KEY='sim'; process.env.RESEND_WEBHOOK_SECRET='w';
process.env.RESEND_INBOUND_WEBHOOK_SECRET='w'; process.env.ANTHROPIC_API_KEY='sim';
process.env.BRAVE_SEARCH_API_KEY='sim';
const {runMigrations}=await import('./src/lib/migrate.ts');
const {getDb}=await import('./src/lib/db.ts');
const {newId}=await import('./src/lib/hash.ts');
const {setLlmProvider}=await import('./src/lib/llm/index.ts');
const {setSearchProvider}=await import('./src/lib/search/index.ts');
const {setEmailProvider}=await import('./src/lib/email/index.ts');
const {runSupervisor}=await import('./src/autonomy/supervisor.ts');
const {buildWorld}=await import('./src/scripts/sim-world.ts');
const {makeSimState,SimLlmProvider,SimSearchProvider,SimEmailProvider}=await import('./src/scripts/sim-providers.ts');
await runMigrations();
const ideas=buildWorld(42).slice(0,8);
const st=makeSimState(ideas,7);
setLlmProvider(new SimLlmProvider(st)); setSearchProvider(new SimSearchProvider(st)); setEmailProvider(new SimEmailProvider(st));
const db=await getDb();
for(const i of ideas){
  await db.query(`INSERT INTO opportunities (id,name,ecosystem,category,state,estimated_build_days,dedupe_key)
    VALUES ($1,$2,'shopify',$3,'DISCOVERED',$4,$5)`,[newId('opp'),i.name,i.category,i.estimatedBuildDays,`shopify:${i.category}`]);
}
const base=new Date(Date.now()-10*24*3600_000);
for(let k=0;k<12;k++){
  const now=new Date(base.getTime()+k*3*3600_000);
  const rep=await runSupervisor({maxWorkItems:12, now});
  const stages=await db.query<{research_stage:number;n:string}>('SELECT research_stage,COUNT(*) AS n FROM opportunities GROUP BY 1 ORDER BY 1');
  const q=await db.query<{status:string;n:string}>('SELECT status,COUNT(*) AS n FROM work_queue GROUP BY 1');
  console.log(`tick${k} dec=${rep.decisions.length} enq=${rep.enqueued} exec=${rep.executed}`,
    '| stages:', stages.rows.map(r=>`${r.research_stage}:${r.n}`).join(','),
    '| queue:', q.rows.map(r=>`${r.status}=${r.n}`).join(','),
    '| skipped:', JSON.stringify(rep.skipped));
}
