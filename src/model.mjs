export function parseMeminfo(text) {
  const values = Object.fromEntries(text.trim().split('\n').map(line => {
    const [key, value] = line.split(':'); return [key, Number.parseInt(value, 10) * 1024];
  }));
  const total = values.MemTotal, available = values.MemAvailable;
  if (!(total > 0 && available >= 0 && available <= total)) throw new Error('invalid-memory-snapshot');
  return { total, available, used: total - available, swapTotal: values.SwapTotal, swapUsed: values.SwapTotal - values.SwapFree };
}
export function cpuBusy(a, b) {
  const delta = b.map((v, i) => v - a[i]); const total = delta.reduce((a,b) => a+b,0);
  if (delta.some(v=>v<0) || total <= 0) return null;
  return Math.round((1 - (delta[3]+delta[4])/total)*1000)/10;
}
export function parseProperties(text) {
  return text.trim().split(/\n\s*\n/).filter(Boolean).map(block => Object.fromEntries(block.split('\n').filter(line=>line.includes('=')).map(line=>{const i=line.indexOf('='); return [line.slice(0,i),line.slice(i+1)];})));
}
export function classifyUnit(unit, required = []) {
  if (unit.active === 'failed' || unit.result && !['success',''].includes(unit.result)) return 'error';
  if (required.includes(unit.name) && unit.active !== 'active' && unit.active !== 'activating') return 'error';
  if (unit.active === 'active') return 'ok';
  if (unit.active === 'activating' || unit.active === 'deactivating') return 'transition';
  if (unit.type === 'oneshot' && unit.result === 'success') return 'idle';
  return 'inactive';
}
export function parseDisks(text) {
  return text.trim().split('\n').slice(1).map(line=>{
    const [source,type,size,used,available,percent,...mount] = line.trim().split(/\s+/);
    return {source,type,total:Number(size),used:Number(used),available:Number(available),percent:Number(percent.replace('%','')),mount:mount.join(' ')};
  }).filter(d=>d.total>0 && !['tmpfs','devtmpfs','overlay','squashfs','efivarfs'].includes(d.type));
}
export function attentionFor(snapshot) {
  const events = [];
  for (const issue of snapshot.collectionIssues ?? []) events.push({severity:'warning',kind:'collection',title:issue});
  for (const unit of snapshot.services ?? []) if (unit.health==='error') events.push({severity:'error',kind:'service',title:unit.name,detail:`${unit.scope} · ${unit.active} · ${unit.result || unit.sub}`});
  for (const unit of snapshot.failedUnits ?? []) if (!(snapshot.services??[]).some(s=>s.scope===unit.scope&&s.name===unit.name&&s.health==='error')) events.push({severity:'error',kind:'unit',title:unit.name,detail:unit.scope});
  for (const c of snapshot.containers??[]) if(c.health==='unhealthy'||c.state==='restarting'||c.state==='dead') events.push({severity:'error',kind:'container',title:c.name,detail:c.health||c.state});
  for (const d of snapshot.disks ?? []) if(d.percent>=85) events.push({severity:d.percent>=95?'error':'warning',kind:'disk',title:d.mount,detail:`${d.percent}% used`});
  if(snapshot.memory && snapshot.memory.available/snapshot.memory.total < .1) events.push({severity:'warning',kind:'memory',title:'Memory available below 10%'});
  for(const probe of snapshot.probes??[]) if(!probe.ok) events.push({severity:'error',kind:'probe',title:probe.name,detail:probe.status?`HTTP ${probe.status}`:'Endpoint unavailable'});
  for(const entry of snapshot.journalErrors??[]) events.push({severity:'warning',kind:'journal',title:entry.unit,detail:`${entry.count} errors in the last hour`});
  return events;
}
