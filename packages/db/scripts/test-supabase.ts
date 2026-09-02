import { query } from '../src/client.ts';
import 'dotenv/config';

async function main() {
  const funcDef = await query(`
    select pg_get_functiondef(p.oid) as def
    from pg_proc p
    join pg_namespace n on p.pronamespace = n.oid
    where n.nspname = 'auth' and p.proname = 'uid'
  `);
  console.log('auth.uid definition in Supabase:');
  console.log(funcDef[0]?.def);

  // Test set_config with request.jwt.claim.sub
  const testId = '11111111-1111-1111-1111-111111111111';
  const uidRes = await query(`
    select set_config('request.jwt.claim.sub', $1, true),
           auth.uid() as uid
  `, [testId]);
  console.log('Result of auth.uid() after setting request.jwt.claim.sub:', uidRes);
}

main().catch(console.error);
