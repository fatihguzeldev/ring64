from pathlib import Path
import json,hashlib,shutil,re,subprocess,datetime
repo=Path('/Users/fatihguzel/ring64'); out=repo/'build/verification/identity-time-causal-artifacts';out.mkdir(exist_ok=True)
hash=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
archive=[]
files={
 '/tmp/ring64-x87-counterfactual.mjs':'counterfactual-harness.mjs',
 '/tmp/ring64-x87-counterfactual-plan.json':'counterfactual-early-plan.json',
 '/tmp/ring64-x87-assembly-capture.mjs':'assembly-capture-harness.mjs',
 '/tmp/ring64-x87-assembly-capture.json':'assembly-capture.json',
 '/tmp/ring64-x87-assembly-compile-receipt.json':'assembly-compile-receipt.json',
 '/tmp/ring64-x87-assembly-audit.json':'assembly-audit.json',
 '/tmp/ring64-x87-assembly-audit.py':'assembly-audit.py',
 '/tmp/ring64-x87-post-helper-register-windows.json':'post-helper-register-windows.json',
}
files.update({str(p):'modules/'+p.name for p in sorted(Path('/tmp/ring64-x87-assembly-modules').iterdir()) if p.is_file()})
for src,name in files.items():
 dst=out/name;dst.parent.mkdir(exist_ok=True);shutil.copyfile(src,dst);assert hash(src)==hash(dst)
 archive.append({'original':src,'durable':str(dst.relative_to(repo)),'bytes':dst.stat().st_size,'sha256':hash(dst)})
# Compact the independently calculated screen; raw values remain in the named
# durable benchmark receipts and are not discarded from those originals.
p=json.loads(Path('/tmp/ring64-identity-time-performance-independent-audit.json').read_text())
compact={k:v for k,v in p.items() if k not in ['rows','wideContextOnlyScreen']};compact['rows']=[{k:v for k,v in r.items() if k!='raw'} for r in p['rows']];compact['rawReceiptCeiling']='This compact index omits duplicate raw arrays; originals are retained unchanged in their durable report files.'
cp=out/'independent-targeted-performance-screen.json';cp.write_text(json.dumps(compact,indent=2)+'\n')
archive.append({'original':'/tmp/ring64-identity-time-performance-independent-audit.json','durable':str(cp.relative_to(repo)),'bytes':cp.stat().st_size,'sha256':hash(cp),'transformation':'Remove duplicate raw arrays only; preserve all84 calculated row summaries, integrity and crosschecks.'})
mut= json.loads((repo/'build/verification/identity-time-mutations.json').read_text()); mutationRows=[]
for row in mut['records']:
 cmds=row['commands'];assert all(c['status']==0 and c['signal'] is None for c in cmds[:-1]);assert cmds[-1]['status']!=0 and cmds[-1]['signal'] is None
 assert re.search(row['assertion'],cmds[-1]['diagnostic'],re.S),row['name']
 assert row['classification']=='killed-by-specific-assertion'
 mutationRows.append({'name':row['name'],'assertion':row['assertion'],'oracleArgv':cmds[-1]['argv'],'setupStatuses':[c['status'] for c in cmds[:-1]],'semanticStatus':cmds[-1]['status']})
before=json.loads((repo/'build/verification/identity-time-source-before.json').read_text());tupleHash=hashlib.sha256(json.dumps([[f['path'],f['sha256']] for f in before['files']],separators=(',',':'),ensure_ascii=False).encode()).hexdigest();assert tupleHash==mut['sourceSha256']
cf= json.loads((repo/'build/verification/identity-time-counterfactual-execution.json').read_text());assert len(cf['jobs'])==7 and all(j['status']==0 for j in cf['jobs'])
perf=json.loads((repo/'build/verification/identity-time-performance-execution.json').read_text());assert len(perf['jobs'])==30 and all(j['status']==0 for j in perf['jobs'])
assembly=json.loads((out/'assembly-audit.json').read_text())
cal=Path('/tmp/ring64-identity-instance-calibration.mjs');plan=repo/'build/verification/identity-time-instance-calibration-plan.json';declared=json.loads(plan.read_text());assert hash(cal)==declared['harnessSha256']
# Archive reviewed exact script now; this does not launch or import it.
calcopy=out/'instance-calibration-reviewed-harness.mjs';shutil.copyfile(cal,calcopy);assert hash(calcopy)==declared['harnessSha256']
archive.append({'original':str(cal),'durable':str(calcopy.relative_to(repo)),'bytes':calcopy.stat().st_size,'sha256':hash(calcopy)})
paths=['build/verification/identity-time-source-before.json','build/verification/identity-time-source-after-initial-performance.json','build/verification/identity-time-mutations.json','build/verification/identity-time-performance-execution.json','build/verification/identity-time-counterfactual-plan.json','build/verification/identity-time-counterfactual-execution.json','build/verification/identity-time-characterization-validation-node.json','build/verification/identity-time-characterization-validation-chrome.json','build/verification/identity-time-characterization-node.json','build/verification/identity-time-characterization-chrome.json','build/verification/identity-time-instance-calibration-plan.json']
paths += [str(p.relative_to(repo)) for p in sorted((repo/'build/verification').glob('identity-time-cf-*-node.json'))]
paths += [str(p.relative_to(repo)) for p in sorted((repo/'build/verification').glob('identity-time-cf-validation-*.json'))]
paths += [str(p.relative_to(repo)) for p in sorted((repo/'build/verification').glob('paging-performance-identity-time-x87-*-report-*.json'))]
paths += [str(p.relative_to(repo)) for p in sorted((repo/'build/verification').glob('identity-time-paging-*-*.json'))]
evidence=[{'path':name,'bytes':(repo/name).stat().st_size,'sha256':hash(repo/name)} for name in paths]
sourceMap=[
 {'contract':'Literal anonymous CPUID profile, modulo64 time sampling/settlement and selected TSC/AUX MSRs','owner':'src/x86/processor.rs','line':18,'nativeTests':'src/x86/processor.rs:89','proofCeiling':'Portable semantics; emitted operation proof additionally needs public runtime oracles.'},
 {'contract':'Timestamp/CPUID decode, all-mode opcode admission and rawF9/prefix frontiers','owners':['src/x86/decode/opcode.rs:632','src/x86/decode/protection.rs:119'],'nativeTests':'src/x86/decode/tests/processor.rs','publicBoundary':'tests/execution/identity-time/boundaries.ts'},
 {'contract':'Single canonical reprC bank and public descriptor','owners':['src/embedding/layout.rs:253','src/embedding/layout.rs:353'],'publicConsumers':['host/time.ts:13','host/core.ts:1111']},
 {'contract':'One generated common-exit settlement of originalB-liveR, zero extension, scoped processor helper calls','owners':['src/dbt/wasm/state.rs:76','src/dbt/wasm/mod.rs:965'],'nativeTests':'src/dbt/wasm/tests/processor.rs','publicRuntime':'tests/execution/identity-time/oracle.ts'},
 {'contract':'Live timestamp TSD admission before scratch/output writes and inherited MSR privilege phase','owners':['src/embedding/exports/processor.rs:5','src/embedding/exports/paging.rs:337'],'nativeTests':'src/embedding/exports/tests/processor.rs','publicBoundary':'tests/execution/identity-time/boundaries.ts'},
 {'contract':'TSD allowed without translation identity change or cached PAE PDPTE reload','owners':['src/x86/paging/controls.rs:286','src/x86/paging/controls.rs:398','src/embedding/exports/paging.rs:485'],'nativeTests':['src/embedding/exports/tests/processor.rs','src/embedding/exports/tests/context_reuse.rs'],'publicBoundary':'tests/execution/identity-time/boundaries.ts'},
 {'contract':'Strict TimeState capture/lifecycle; separate scalar/state/time API; no setter rollback of accessor effects','owners':['host/time.ts:13','host/cpu.ts:385'],'hostTests':'host/time.test.ts','publicBoundary':'tests/execution/identity-time/boundaries.ts'},
]
for row in sourceMap:
 for key in ['owner','nativeTests','publicBoundary','publicRuntime','hostTests']:
  if key in row:
   vals=row[key] if isinstance(row[key],list) else [row[key]]
   for val in vals:assert (repo/val.split(':')[0]).is_file(),(key,val)
index={
 'mode':'independent-source-evidence-index-no-new-guest-or-timing-execution',
 'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'source':{'commit':before['commit'],'sourceInventoryFiles':len(before['files']),'sourceManifest':'build/verification/identity-time-source-before.json','sourceManifestTreeContentSha256':before['treeContentSha256'],'mutationSourceSha256':tupleHash,'hashDistinction':'treeContentSha256 and mutationSourceSha256 use different encodings. Mutation SHA is SHA256(JSON.stringify(sorted [path,fileSHA] tuples)); it was independently recomputed from all773 source manifest entries.'},
 'frozenArtifacts':{'baseline':declared['identities']['baseline'],'current':declared['identities']['current']},
 'sourceContractMap':sourceMap,
 'executedEvidence':{'semanticValidation':{'receipts':['build/verification/identity-time-characterization-validation-node.json','build/verification/identity-time-characterization-validation-chrome.json'],'workloadsPerRuntime':22,'samplesPerRuntime':44,'claimCeiling':'New-behavior validation, not predecessor timing comparison.'},'mutationCampaign':{'receipt':'build/verification/identity-time-mutations.json','executed':True,'namedSemanticKills':len(mutationRows),'originalSourceUnchanged':mut['originalSourceUnchanged'],'rows':mutationRows,'claimCeiling':'Every setup completed0 and each actual nonsignal failure matched its precise semantic assertion. Commands include public emitted scenarios, host lifecycle, decode frontier and one native PAE case; command cohort is not identical to first-failure observation layer.'},'initialSerializedPerformance':{'receipt':'build/verification/identity-time-performance-execution.json','jobs':30,'allStatusesZero':True,'claimCeiling':'Executed benchmark envelopes and semantic guards; ratios require declared later cutoffs, A/A/order controls and row-specific uncertainty.'},'sameCoreCounterfactual':{'receipt':'build/verification/identity-time-counterfactual-execution.json','jobs':7,'allStatusesZero':True,'variants':['omit','move-after-publication','future-bias'],'directions':['primary','reverse'],'control':'as-is/as-is','oldGoldenProof':'build/verification/identity-time-cf-validation-omit.json','claimCeiling':'Only generated CodeSection changes within SAME candidate Core/host; invalid-clock omit diagnostic and fixed non-timestamp future variant do not prove a shipping implementation. Omit unitSHA matching predecessor does not replace predecessor Core/helper/layout.'}},
 'machineCodeAudit':{'capture':'build/verification/identity-time-causal-artifacts/assembly-capture.json','compileReceipt':'build/verification/identity-time-causal-artifacts/assembly-compile-receipt.json','audit':'build/verification/identity-time-causal-artifacts/assembly-audit.json','pathRemapping':'Archived raw receipts preserve original /tmp paths byte-for-byte. Resolve them with archive[].original -> archive[].durable below.','uniqueGeneratedModules':8,'capturedHashesMatchCounterfactualReceipts':True,'compiler':'Node22.16.0 ARM64 TurboFan; fresh process per unit, --no-liftoff --no-wasm-lazy-compilation --print-wasm-code-function-index=4 --code-comments; no Core instantiation in assembly process.','facts':['Original B is incomingx2 per exact Node22.16.0 wasm ABI source; source links and slot traces retained in audit.','As-is/move B has entry store, epilogue reload and entry-stack-check slow-path reload only; zero recurring hot-span accesses.','x87 frame is224 bytes as-is/move versus208 omit/future, after a fixed32byte prologue.','Static nonfaulting recurring x87 CFG paths:222/217/222/207 instructions as-is/omit/move/future. All have61loads/7stores, including40SPloads/7SPstores, and5helper calls.','Future removes five3-MOV post-helper swaps; these15MOVs establish a register-shuffle difference, not a demonstrated speedup.','Same-Core timing did not demonstrate improvement for these variants; repeated B spilling and a historical-performance causal explanation remain unproved.'],'claimCeilings':['Static CFG path counts exclude imported helper internals and stack-check slow paths; they are not measured dynamic instruction retirement.','No new timing was executed by capture/compile-only assembly audit.','No production rewrite follows from fewer instructions or a smaller frame.']},
 'instanceCalibrationPreflight':{'harness':'build/verification/identity-time-causal-artifacts/instance-calibration-reviewed-harness.mjs','harnessSha256':hash(calcopy),'plan':'build/verification/identity-time-instance-calibration-plan.json','planSha256':hash(plan),'status':'ready-for-execution; execution/results are owned by root and not claimed by this preflight','blockers':[],'resolvedFinding':'Actual consumed Core bytes are now hashed against pinned identity before compiling those same bytes. Host dynamic-import bytes rely on declared operational quiet plus before/after hashes, with no transient-change detection claim.','methodChecks':['Fixed current/baseline ratio direction survives reversed creation arrays.','Eight fresh CPU pairs per cohort/workload; headline median of eight per-pair medians, not40 independent pairs.','AB/BA creation4/4 and cohort-first order orthogonal; alternating per-sample execution balances odd five-later3/2 order across eight replicates.','Real Instance/result and CPU objects retained; instantiate observer only during factory, restored before sampling; metadata reads after factory timer.','Unchanged measure imports/resets inputs outside elapsed run timer, validates semantic/context/numeric/memory/resource flow, and disposes each live pair in finally.'],'ceilings':['Fresh-instance replicate estimates share one process and compiled Core; statistical independence of engine/OS/allocation factors is not established.','Sample0 is a cold translation-owner event, not a proof of cold V8 machine code.','Linear state offsets modulo16/64 do not measure native backing addresses, hardware cache lines or misses.','Cpu.creationMs includes instantiate promise bookkeeping; no uninstrumented startup comparison.','No per-sample TimeState assertion is introduced by this calibration; dedicated semantic receipts carry the clock proof.']},
 'durableEvidence':evidence,
 'archive':archive,
 'deliveryCeiling':'Evidence index does not claim commit/push, full test-suite totals, final calibration results or resolved zero-overhead performance. Those require the root final delivery receipts.'
}
# The frozen identity object includes every file record already in the plan;
# keep compact roots plus their aggregate identities in this map.
for key,val in index['frozenArtifacts'].items():index['frozenArtifacts'][key]={k:v for k,v in val.items() if k not in ['hostFiles','benchmarkFiles']}
p=repo/'build/verification/identity-time-causal-audit.json';p.write_text(json.dumps(index,indent=2)+'\n')
print(json.dumps({'index':str(p),'indexBytes':p.stat().st_size,'archivedFiles':len(archive),'archivedBytes':sum(x['bytes'] for x in archive),'namedSemanticKills':len(mutationRows),'sameCoreCounterfactualJobs':len(cf['jobs']),'productionGitStatus':subprocess.check_output(['git','status','--short'],cwd=repo,text=True).splitlines()},indent=2))
