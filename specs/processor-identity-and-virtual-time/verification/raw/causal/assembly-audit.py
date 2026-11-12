import json,re,hashlib,difflib
from pathlib import Path
root=Path('/tmp/ring64-x87-assembly-modules')
receipt=json.loads(Path('/tmp/ring64-x87-assembly-compile-receipt.json').read_text())
records=[]
for rec in receipt['records']:
 p=Path(rec['assembly']); content=p.read_text(); inst=[]
 for line in content.splitlines():
  m=re.match(r'^(0x[0-9a-f]+)\s+([0-9a-f]+)\s+([0-9a-f]{8})\s+(.+)$',line)
  if m: inst.append(dict(address=int(m[1],16),offset=int(m[2],16),encoding=m[3],text=m[4],mnemonic=m[4].split()[0]))
 byoff={i['offset']:i for i in inst}
 back=next(i for i in inst if i['text'].startswith('b.ne #-'))
 backdelta=int(re.search(r'#-0x([0-9a-f]+)',back['text'])[1],16)
 start=back['offset']-backdelta
 hot=[i for i in inst if start<=i['offset']<=back['offset']]
 # This is a source/CFG path, not executed-instruction profiling. Nonfaulting
 # recurring path selects dispatcher case0 and bypasses conditional exits.
 path=[]; pos=start
 while True:
  i=byoff[pos]; path.append(i)
  if pos==back['offset']:break
  if len(path)>1000:raise Exception('CFG loop')
  if i['mnemonic']=='br':
   # ADR x16 preceding the branch establishes jump-table base at branch+4;
   # the recurring header sets the br_table selector to0 each iteration.
   assert i['text']=='br x16'; pos+=4
  elif i['mnemonic']=='b':
   delta=re.search(r'#([+-])0x([0-9a-f]+)',i['text']); assert delta
   pos+=int(delta[2],16)*(1 if delta[1]=='+' else -1)
  else:pos+=4
  assert start<=pos<=back['offset'],(rec['workload'],rec['variant'],hex(pos))
 def stats(xs):
  hist={}
  for i in xs:hist[i['mnemonic']]=hist.get(i['mnemonic'],0)+1
  mem=[i for i in xs if re.match(r'^(?:ld|st)',i['mnemonic'])]
  spl=[i for i in mem if '[sp' in i['text']]
  return dict(instructions=len(xs),loads=sum(i['mnemonic'].startswith('ld') for i in xs),stores=sum(i['mnemonic'].startswith('st') for i in xs),spLoads=sum(i['mnemonic'].startswith('ld') for i in spl),spStores=sum(i['mnemonic'].startswith('st') for i in spl),indirectCalls=hist.get('blr',0),histogram=hist)
 # Address-independent rendering keeps registers and concrete stack offsets.
 neutral=[]
 for i in path:
  s=re.sub(r' \(addr 0x[0-9a-f]+\)','',i['text'])
  s=re.sub(r'#([+-])0x([0-9a-f]+)',lambda m:f'target@{i["offset"]+(1 if m[1]=="+" else -1)*int(m[2],16):x}',s)
  neutral.append(f'{i["offset"]:04x}: {s}')
 # Shape view preserves register names and instruction order, canonicalizes only
 # stack-slot names by first occurrence and branch targets by path-vs-cold role.
 slots={}; normalized=[]
 for i in path:
  s=re.sub(r' \(addr 0x[0-9a-f]+\)','',i['text'])
  def slot(m):
   val=int(m[1]); slots.setdefault(val,f'S{len(slots)}'); return f'[sp, {slots[val]}]'
  s=re.sub(r'\[sp, #([0-9]+)\]',slot,s)
  if i['mnemonic'] in ['b','b.ne','b.hs','b.ls','cbz','cbnz']:
   s=re.sub(r'#[+-]0x[0-9a-f]+','TARGET',s)
  normalized.append(s)
 nfile=root/f'{rec["workload"]}-{rec["variant"]}.normal-cycle.txt'
 nfile.write_text('\n'.join(neutral)+'\n')
 shape=root/f'{rec["workload"]}-{rec["variant"]}.normal-cycle.shape.txt'
 shape.write_text('\n'.join(normalized)+'\n')
 entry=next(i for i in inst if re.match(r'str x2, \[sp, #[0-9]+\]$',i['text']))
 entryslot=int(re.search(r'#([0-9]+)',entry['text'])[1])
 slotaccess=[i for i in inst if f'[sp, #{entryslot}]' in i['text']]
 # Only the as-is/move save retains original B. Omit/future reuse their entry
 # slot for mutable remainingR, so listing their slot is not a B identity claim.
 originalB=rec['variant'] in ['as-is','move-after-publication']
 btrace=[{'offset':hex(i['offset']),'instruction':i['text'].split(' (addr')[0]} for i in slotaccess] if originalB else None
 if originalB:
  assert len(slotaccess)==3,(rec,slotaccess)
  assert entry['offset']==0x18
  assert not any(start<=i['offset']<=back['offset'] for i in slotaccess)
 frame=int(re.search(r'sub sp, sp, #0x[0-9a-f]+ \(([0-9]+)\)',content)[1])
 body=re.search(r'Body \(size = ([0-9]+) = ([0-9]+) \+ ([0-9]+) padding\)',content)
 insbytes=int(re.search(r'Instructions \(size = ([0-9]+)\)',content)[1])
 records.append({**rec,'assemblySha256':hashlib.sha256(content.encode()).hexdigest(),'frameAllocationAfterFixed32BytePrologue':frame,'bodyBytesIncludingPadding':int(body[1]),'bodyBytesBeforePadding':int(body[2]),'instructionBytes':insbytes,'hotSpan':{'start':hex(start),'backedge':hex(back['offset']),'staticSpan':stats(hot)},'normalRecurringCycle':{**stats(path),'method':'CFG path: dispatcher case0; conditional forward fault/budget/debug/numeric-admission exits not taken; unconditional branches followed; recurring backedge taken. Imported helper internals and stack-check slow paths excluded. This is not measured dynamic instruction retirement.','pathFile':str(nfile),'shapeFile':str(shape),'stackSlotNameMap':slots},'originalBudget':{'wasmParameter':1,'incomingArm64Register':'x2','savedStackOffset':entryslot,'allSlotAccesses':btrace,'recurringLoopSlotAccesses':0} if originalB else {'identityCeiling':'original B is consumed at entry (future-bias) or dead after initialization (omit); entry physical slot reuse is not a B spill trace'}})
comparisons=[]
for w in ['x87','mmx']:
 a=next(r for r in records if r['workload']==w and r['variant']=='as-is')
 ashape=Path(a['normalRecurringCycle']['shapeFile']).read_text()
 for v in ['omit','move-after-publication','future-bias']:
  b=next(r for r in records if r['workload']==w and r['variant']==v)
  bshape=Path(b['normalRecurringCycle']['shapeFile']).read_text()
  delta={k:b['normalRecurringCycle'][k]-a['normalRecurringCycle'][k] for k in ['instructions','loads','stores','spLoads','spStores','indirectCalls']}
  df=root/f'{w}-as-is-vs-{v}.shape.diff.txt'
  df.write_text(''.join(difflib.unified_diff(ashape.splitlines(True),bshape.splitlines(True),fromfile='as-is',tofile=v)))
  comparisons.append(dict(workload=w,variant=v,sameNormalizedRecurringShape=ashape==bshape,normalCycleCountDelta=delta,normalizedDiff=str(df)))
audit=dict(mode='off-timing-generated-module-TurboFan-static-audit',node=receipt['node'],hostISA='arm64',captureReceipt='/tmp/ring64-x87-assembly-capture.json',compileReceipt='/tmp/ring64-x87-assembly-compile-receipt.json',capturedModuleHashesMatchPriorReceipts=True,productionSourceModified=False,records=records,comparisons=comparisons,conclusions=['As-is and move retain original B in one saved stack slot; only entry store, common epilogue reload and entry stack-check slow-path reload access that slot. There are zero accesses in the recurring hot span. Physical x2 reuse in helper calls does not preserve original-B identity.','Retaining B increases frame allocation by16 bytes compared with omit/future-bias in these compiled units. This establishes a frame-layout difference, not repeated B spill traffic or a performance cause.','No timer data is produced by this audit. Prior symmetric same-Core counterfactual timing did not show improvement for omit/move/future versus as-is; static instruction/frame differences cannot establish an optimization or explain the historical whole-Core timing gap.','No production code rewrite or IR-allocation-trace escalation is justified by this particular hypothesis: recurring original-B-slot traffic is absent.'])
Path('/tmp/ring64-x87-assembly-audit.json').write_text(json.dumps(audit,indent=2)+'\n')
print(json.dumps({'records':[{k:r[k] for k in ['workload','variant','frameAllocationAfterFixed32BytePrologue','instructionBytes','normalRecurringCycle','originalBudget']} for r in records],'comparisons':comparisons},indent=2))
