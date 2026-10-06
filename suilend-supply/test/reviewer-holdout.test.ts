// Independent reviewer holdout cases (R1).
import path from 'node:path';
import { expect, it } from 'vitest';
import { Journal } from '../src/journal.js';
import { acquireLock } from '../src/lock.js';
import { journalReconcileCommand, supplyCommand, type Deps } from '../src/app.js';
import { FAKE_WAAP, OWNER, tmpDir, readLog } from './helpers.js';
import { worldChain } from './world-chain.js';
// @ts-expect-error fixture
import { newWorld, writeWorld } from './fixtures/world.mjs';

it('a different historical failed transaction must not close an unknown submission or permit a second send', async () => {
  const dir = tmpDir('reviewer-wrong-failed-digest-');
  const file = path.join(dir, 'world.json');
  const oldDigest = 'UNRELATED_OLD_FAILED_TRANSACTION';
  const world = newWorld();
  world.txs[oldDigest] = {status:'failure', sender:OWNER, gasOwner:OWNER, gasMist:'2000000', suiChange:{[OWNER]:'-2000000'}};
  writeWorld(file, world);
  const journal = new Journal(path.join(dir, 'state'));
  const held = acquireLock(journal.dir, 'controlled unknown submission');
  const id = journal.start(held, {action:'supply',address:OWNER,summary:'unresolved intended supply',context:{obligationIdsBefore:world.obligations.map((o:any)=>o.obligationId),obligationId:world.obligations[0].obligationId,ctokensBefore:world.obligations[0].suiCtokens,amountMist:'1000000000',expectedCtokens:'952380952'}});
  held.release();
  const log = path.join(dir,'waap-calls.jsonl');
  const deps:Deps = {chain:worldChain(file).deps,journal,reporter:{progress(){},event(){}},reconcile:{attempts:2,delayMs:1},waap:{command:[process.execPath,FAKE_WAAP],childStdin:'ignore',env:{...process.env,FAKE_WORLD:file,FAKE_WAAP_SCENARIO:'ok',FAKE_WAAP_LOG:log,FAKE_WAAP_ADDRESS:OWNER}}};
  let recoveryCode;
  try {await journalReconcileCommand(deps,{id,digest:oldDigest});}catch(e:any){recoveryCode=e.code;}
  const afterRecovery=journal.latest()[0].state;
  let nextOutcome;
  try {nextOutcome=(await supplyCommand(deps,{amount:'1',yes:true}) as any).outcome;}catch(e:any){nextOutcome=e.code;}
  const sends=readLog(log).filter((r:any)=>r.args[0]==='send-tx').length;
  console.log(JSON.stringify({recoveryCode,afterRecovery,nextOutcome,sends}));
  expect({state:afterRecovery,sends}, 'an unrelated old digest must not resolve this submission').toEqual({state:'submitting',sends:0});
});
