from pathlib import Path
import json,hashlib,statistics,math,collections,subprocess
repo=Path('/Users/fatihguzel/ring64'); verify=repo/'build/verification'
receipt=verify/'identity-time-instance-calibration-node.json'; planpath=verify/'identity-time-instance-calibration-plan.json'; harness=Path('/tmp/ring64-identity-instance-calibration.mjs')
hash=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
j=json.loads(receipt.read_text()); plan=json.loads(planpath.read_text()); med=statistics.median
assert j['declared']==plan and j['planSha256']==hash(planpath)
assert hash(harness)==plan['harnessSha256']=='d029c80c5e0179a611817d1e8da900b4d7177daf7ab1a2430c60e15a527de8ba'
assert hash(planpath)=='f76e7aa3a0b81f1770b56e363a3805ad93b29f98cca7baf7dfbd07e6e8b1086d'
assert j['mode']=='executed-independent-cpu-pair-calibration' and all(j['postRunIntegrity'].values())
assert j['environment']==plan['environment']
assert plan['knobs']=={'replicates':8,'iterations':1000001,'samples':9,'laterStart':4,'workloads':['x87-stack-churn','mmx-x87-emms'],'reverse':False}
assert len(j['runs'])==16 and len(j['placements'])==64 and len(j['pairs'])==288 and len(j['replicateStats'])==32
N=1000001; workloads=['x87-stack-churn','mmx-x87-emms']; gbase=0x1122334400000000; mask128=(1<<128)-1
forms={workloads[0]:{'code':'d9e8d9eed9c9ddd8ddd8e2f4','instructions':6,'sourceBytes':12,'entries':[4096,4098,4100,4102,4104,4106],'oldBytes':1083,'newBytes':1101},workloads[1]:{'code':'0fefc00f77d9e8ddd8e2f5','instructions':5,'sourceBytes':11,'entries':[4096,4099,4101,4103,4105],'oldBytes':1095,'newBytes':1113}}
checks=collections.Counter(); repro_pairs=[]; repro_rep=[]; placement_summary=collections.Counter(); creation_grid=collections.Counter(); execution_grid=collections.Counter(); later_positive=collections.Counter()
def eq(a,b,label):assert a==b,(label,a,b)
def comparable(row):
 a={k:v for k,v in row.items() if k not in ['side','elapsedMs','timings','creationMs','resources','units']}
 a['resources']={k:v for k,v in row['resources'].items() if k not in ['generatedBytes','cachedBytes']}
 a['units']=[{k:v for k,v in u.items() if k not in ['owner','byteLength']} for u in row['units']];return a
for index,run in enumerate(j['runs']):
 item={k:run[k] for k in ['replicate','cohort','creationOrder']};eq(item,plan['schedule'][index],'schedule');result=run['result'];cohort=run['cohort'];replicate=run['replicate'];order=run['creationOrder']
 eq(result['unavailable'],[],'unavailable');eq(result['exceptionIdle'],False,'exceptionIdle');eq(result['matchedDelivery'],False,'matchedDelivery');eq(result['reverse'],False,'reverse')
 eq(result['limits'],{'maxInstructions':128,'maxSourceBytes':2048,'maxArtifactBytes':262144,'maxCachedArtifacts':32,'maxCachedBytes':4194304,'maxTranslationsPerRun':32},'effective limits')
 eq([d['name'] for d in result['definitions']],workloads,'definition order');eq(len(result['samples']),36,'sample count')
 expectedOrder=[(w,s,side) for w in workloads for s in range(9) for side in (order[::-1] if s%2 else order)]
 eq([(r['workload'],r['sample'],r['side']) for r in result['samples']],expectedOrder,'sample order')
 placements=[p for p in j['placements'] if p['replicate']==replicate and p['cohort']==cohort]
 eq([(p['workload'],p['label'],p['ordinal']) for p in placements],[(w,side,2*wi+oi) for wi,w in enumerate(workloads) for oi,side in enumerate(order)],'placement creation order')
 for p in placements:
  artifact='current' if cohort=='current-current-aa' else p['label'];eq(p['artifact'],artifact,'own factory artifact');eq(p['creationOrder'],order,'placement order')
  ptr=p['statePointer'];eq(ptr,1114624,'observed linear pointer');eq(p['statePointerHex'],hex(ptr),'pointer hex');eq(p['statePointerMod16'],ptr%16,'state mod16');eq(p['statePointerMod64'],ptr%64,'state mod64');eq(p['stateBytes'],784 if artifact=='current' else 768,'state bytes')
  bank=p['x87'];eq({k:bank[k] for k in ['offset','bytes','registerBytes','bankBase','bankBaseMod16','bankBaseMod64','initialTop']},{'offset':456,'bytes':104,'registerBytes':10,'bankBase':ptr+456,'bankBaseMod16':8,'bankBaseMod64':8,'initialTop':0},'x87 descriptor/placement')
  for slot in bank['physicalSlots']:
   start=ptr+456+slot['slot']*10;end=start+9;eq(slot,{'slot':slot['slot'],'start':start,'endInclusive':end,'length':10,'startMod16':start%16,'startMod64':start%64,'endMod16':end%16,'endMod64':end%64,'spans16ByteBoundary':start//16!=end//16,'spans64ByteBoundary':start//64!=end//64},'physical-slot boundaries')
  placement_summary[(artifact,ptr,p['stateBytes'],bank['bankBaseMod64'])]+=1;checks['placement']+=1
 for definition in result['definitions']:
  w=definition['name'];f=forms[w];eq(definition['code'],f['code'],'literal code');eq(int(definition['iterations']),N,'actualN');eq(int(definition['instructions']),N*f['instructions'],'actual retirement budget');eq(definition['repeatBudget'],'0','repeat budget');eq(definition['profile'],'long64','profile');eq(definition['resume'],False,'nonresume');eq(definition['throughputUnit'],'guest instructions','work unit')
  later=[];creation_grid[(cohort,w,order[0])]+=1
  for sample in range(9):
   a,b=[next(r for r in result['samples'] if r['workload']==w and r['sample']==sample and r['side']==side) for side in ['baseline','current']]
   eq(comparable(a),comparable(b),'paired full recorded semantics/resources');checks['paired_semantics']+=1
   for r in [a,b]:
    artifact='current' if cohort=='current-current-aa' else r['side'];window='first' if sample==0 else 'early' if sample<4 else'later';eq(r['window'],window,'window');eq(r['exceptionDelivery'],'report','delivery policy')
    expectedg=[str(gbase+i) for i in range(16)];expectedg[1]='0';expectedg[3]='16400';eq(r['state']['registers'],expectedg,'all16GPR');eq(r['state']['flags'],'3287','preserved flags');eq(r['state']['rip'],str(4096+f['sourceBytes']),'final RIP');eq(r['state']['event'],{'kind':'ready'},'ready');eq(r['state']['interruptibility'],{'sti':False,'ss':False},'shadows');eq(r['state']['interrupts'],{'irq':None,'nmiPending':False,'nmiBlocked':False},'interrupt latches')
    eq(r['mxcsr'],8064,'MXCSR');eq(r['xmm'],[str(((0x102030405060708090a0b0c0d0e0f001*(i+1))^(sample<<67))&mask128) for i in range(16)],'allXMM')
    regs=[str(((0xa000+i)<<64)|(i+sample+1)) for i in range(8)]
    if w==workloads[0]:regs[6]=str(0x3fff8000000000000000);regs[7]='0';cw=0x37f|((sample%4)<<10);ip=4104
    else:regs[0]=str(0xffff<<64);regs[7]=str(0x3fff8000000000000000);cw=0x37f;ip=4103
    x=r['x87'];eq(x['registers'],regs,'all8 physical x87');eq(x['controlWord'],cw,'x87 PC/RC');eq(x['statusWord']&0xbaff,0,'x87 defined status');eq(x['tagWord'],65535,'x87 tags');eq(x['opcode'],291,'x87 opcode');eq(x['instructionPointer'],str(ip),'x87 source pointer');eq(x['dataPointer'],str(0x8877665544332211),'x87 data pointer')
    units=r['units'];eq(len(units),1,'one cached unit');unit=units[0];byteLength=f['newBytes'] if artifact=='current' else f['oldBytes'];eq(unit,{'blockCount':1,'boundaryObserved':False,'contextVersion':'0','dependencies':[{'start':'4096','length':f['sourceBytes']}],'entries':[str(x) for x in f['entries']],'instructionCount':f['instructions'],'owner':'1','sourceBytes':f['sourceBytes'],'byteLength':byteLength},'unit shape and byte accounting')
    eq(r['resources'],{'compilations':int(sample==0),'cacheHits':int(sample>0),'nativeEntries':1,'dispatches':0,'generatedBytes':byteLength if sample==0 else 0,'cachedArtifacts':1,'cachedBytes':byteLength},'resource flow')
    assert math.isfinite(r['elapsedMs']) and r['elapsedMs']>=0
    assert math.isfinite(r['creationMs']) and r['creationMs']>=0
    for k,val in r['timings'].items():assert math.isfinite(val) and val>=0,(k,val)
    if sample>0:eq({k:r['timings'][k] for k in ['translationMs','browserCompileMs','instantiationMs']},{k:0 for k in ['translationMs','browserCompileMs','instantiationMs']},'warm compile phase zeros')
    checks['raw_side_samples']+=1
   denominator=a['elapsedMs'];numerator=b['elapsedMs'];defined=denominator!=0;delta=numerator-denominator
   q={**item,'workload':w,'sample':sample,'window':'first' if sample==0 else'early' if sample<4 else'later','denominatorMs':denominator,'numeratorMs':numerator,'ratio':numerator/denominator if defined else None,'ratioDefined':defined,'deltaMs':delta,'deltaNsPerGuestInstruction':delta*1e6/(N*f['instructions']),'cachedByteDelta':b['resources']['cachedBytes']-a['resources']['cachedBytes'],'generatedByteDelta':b['resources']['generatedBytes']-a['resources']['generatedBytes']};repro_pairs.append(q)
   if sample>=4:later.append(q);execution_grid[(cohort,w,('baseline' if order[0]=='baseline' else'current') if sample%2==0 else('current' if order[0]=='baseline' else'baseline'))]+=1
  defined=[r['ratio'] for r in later if r['ratioDefined']]
  repro_rep.append({**item,'workload':w,'laterPairCount':5,'definedRatios':len(defined),'undefinedRatios':5-len(defined),'medianPairedRatio':med(defined) if defined else None,'asIsLabel':'baseline','numeratorLabel':'current','medianDeltaMs':med(r['deltaMs'] for r in later),'medianDeltaNsPerGuestInstruction':med(r['deltaNsPerGuestInstruction'] for r in later),'slowerCount':sum(r['deltaMs']>0 for r in later),'zeroDeltaCount':sum(r['deltaMs']==0 for r in later)})
eq(repro_pairs,j['pairs'],'ALL288 recomputed pair records');eq(repro_rep,j['replicateStats'],'ALL32 recomputed replicate records')
summaries=[]
for c in ['baseline-current','current-current-aa']:
 for w in workloads:
  rr=[r for r in repro_rep if r['cohort']==c and r['workload']==w];ratios=[r['medianPairedRatio'] for r in rr if r['medianPairedRatio'] is not None]
  s={'cohort':c,'workload':w,'independentCpuPairs':8,'laterPairsPerCpuPair':5,'medianReplicatePairedRatio':med(ratios),'definedReplicateRatios':len(ratios),'undefinedReplicateRatios':8-len(ratios),'minReplicateRatio':min(ratios),'maxReplicateRatio':max(ratios),'medianReplicateDeltaMs':med(r['medianDeltaMs'] for r in rr),'medianReplicateDeltaNsPerGuestInstruction':med(r['medianDeltaNsPerGuestInstruction'] for r in rr),'creationOrderGroups':[]}
  for first in ['baseline','current']:
   g=[r for r in rr if r['creationOrder'][0]==first];s['creationOrderGroups'].append({'first':first,'independentCpuPairs':len(g),'medianReplicatePairedRatio':med(r['medianPairedRatio'] for r in g),'medianReplicateDeltaMs':med(r['medianDeltaMs'] for r in g)})
  summaries.append(s)
eq(summaries,j['summaries'],'ALL summary/creation-stratum fields')
# Verify the frozen on-disk Core and host/benchmark files still match the plan.
frozen=[]
for role,id in plan['identities'].items():
 base=Path(id['path']);eq(hash(base/'build/ring64.wasm'),id['coreSha256'],'frozen CoreSHA')
 for category,folder in [('hostFiles','build/host'),('benchmarkFiles','benchmarks')]:
  for f in id[category]:eq(hash(base/folder/f['name']),f['sha256'],f'{role}/{category}/{f["name"]}')
 frozen.append({'artifact':role,'coreSha256':id['coreSha256'],'hostSha256':id['hostSha256'],'verifiedFiles':len(id['hostFiles'])+len(id['benchmarkFiles'])+1})
observations=[]
for s in summaries:
 rr=[r for r in repro_rep if r['cohort']==s['cohort'] and r['workload']==s['workload']]
 observations.append({**s,'positiveReplicateMedians':sum(r['medianPairedRatio']>1 for r in rr),'negativeReplicateMedians':sum(r['medianPairedRatio']<1 for r in rr),'replicates':[{'replicate':r['replicate'],'first':r['creationOrder'][0],'ratio':r['medianPairedRatio'],'deltaMs':r['medianDeltaMs']} for r in rr]})
audit={'mode':'independent-read-only-receipt-audit-no-execution','receipt':str(receipt.relative_to(repo)),'receiptSha256':hash(receipt),'plan':str(planpath.relative_to(repo)),'planSha256':hash(planpath),'harnessSha256':hash(harness),'allGuardsAndRecomputedFieldsPass':True,'checks':dict(checks),'recordCounts':{'rawSideSamples':576,'allPairs':288,'laterPairs':160,'freshCpuPlacements':64,'measureCalls':16,'replicateEstimates':32,'headlineGroups':4},'frozenArtifacts':frozen,'rawZeros':sum(r['elapsedMs']==0 for x in j['runs'] for r in x['result']['samples']),'undefinedRatios':sum(not r['ratioDefined'] for r in repro_pairs),'resourceByteDeltas':dict(collections.Counter(str(r['cachedByteDelta']) for r in repro_pairs)),'placements':{'observedGroups':[{'artifact':k[0],'statePointer':k[1],'stateBytes':k[2],'x87BankMod64':k[3],'count':v} for k,v in placement_summary.items()],'facts':['Every observed statePointer was1114624, aligned modulo16/64 to0; x87 bank offset456, modulo16/64 both8.','Baseline bank768bytes; current784bytes. Recorded slot3/4 payload ranges are arithmetically correct for every placement.','All64 linear offsets coincide; this does not establish native memory/cache-line placement or actual active TOP during execution.']},'balance':{'creationGroups':[{'cohort':k[0],'workload':k[1],'first':k[2],'pairs':v} for k,v in creation_grid.items()],'laterExecutionFirstGroups':[{'cohort':k[0],'workload':k[1],'first':k[2],'laterPairs':v} for k,v in execution_grid.items()]},'results':observations,'verdict':'The original single-pair0.9–2.6percent Node x87 loss is not established as a repeatable artifact regression by the combined preserved evidence. Balanced fresh-pair calibration center is+0.102percent with4 positive/4 negative replicate medians; current/current A/A center is+0.236percent and order strata change sign. Same-Core clock removal/relocation/B-liveness counterfactuals did not recover speed. This neither proves zero cost nor proves the earlier observation fixed or caused by creation order.','claimCeilings':['These are8 fresh CPU-pair replicates per cohort/workload in one shared process/compiled Core, not demonstrated independent engine or OS realizations.','Do not pool40 later pairs as40 independent CPU pairs. No arbitrary performance threshold or statistical-significance claim is introduced.','Recorded full scalar/context/numeric packets and unit/resource flow were independently rechecked. RAM/code runtime guards were executed by the unchanged benchmark but their byte arrays are not serialized in this receipt, so no independent RAM/code snapshot comparison is claimed here.','No per-sample TimeState observation is present; clock correctness comes from dedicated semantic verification and mutation evidence.','Zero-overhead, resolved root cause, fixed regression, native-address alignment and hardware cache-miss claims remain unsupported.']}
out=verify/'identity-time-instance-calibration-audit.json';out.write_text(json.dumps(audit,indent=2)+'\n')
causal=verify/'identity-time-causal-audit.json';c=json.loads(causal.read_text());c['instanceCalibrationPreflight']['status']='executed; independently audited all576 raw samples/64 placements and all derived pair/replicate/summary fields';c['instanceCalibrationPreflight']['completedReceipt']=str(receipt.relative_to(repo));c['instanceCalibrationPreflight']['independentAudit']=str(out.relative_to(repo));c['instanceCalibrationPreflight']['verdict']=audit['verdict'];c['durableEvidence'].extend([{'path':str(p.relative_to(repo)),'bytes':p.stat().st_size,'sha256':hash(p)} for p in [receipt,out]]);causal.write_text(json.dumps(c,indent=2)+'\n')
print(json.dumps({'audit':str(out),'checks':dict(checks),'rawZeros':audit['rawZeros'],'undefinedRatios':audit['undefinedRatios'],'results':[{k:s[k] for k in ['cohort','workload','medianReplicatePairedRatio','minReplicateRatio','maxReplicateRatio','medianReplicateDeltaNsPerGuestInstruction','positiveReplicateMedians','negativeReplicateMedians']} for s in observations]},indent=2))
