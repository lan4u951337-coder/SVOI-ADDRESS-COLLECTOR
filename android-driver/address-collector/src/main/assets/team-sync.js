/* СВОИ ТАКСИ: opt-in team sync. Local collection remains usable without a server. */
(()=>{
'use strict';
if(window.SvoiTeamSync)return;
const ENDPOINT='https://svoi-taxi24.ru/api/collector-addresses';
const CONFIG_KEY='svoi.addressCollector.team.credentials.v1';
const SYNC_KEY='svoi.addressCollector.team.uploaded.v1';
const DELETE_KEY='svoi.addressCollector.team.explicitDeletes.v1';
const CACHE_KEY='svoi.addressCollector.team.cache.v1';
const OPERATOR_HIDDEN_KEY='svoi.addressCollector.team.operatorHidden.v1';
const $=id=>document.getElementById(id);
const core=window.SvoiAddressCore;
let credentials=null,shared=[],stats=[],total=0,synced={},deletedIds=[],running=false,queued=false,offline=false;
let conflicts=new Map(),timer=null,lastSuccess=0,operatorHiddenIds=new Set();
function loadJson(key,fallback){
  try{return JSON.parse(localStorage.getItem(key)||'null')||fallback}catch{return fallback}
}
function writeJson(key,value){
  try{localStorage.setItem(key,JSON.stringify(value));return true}catch{return false}
}
function localRows(){return window.SvoiCollector?.localRows?.()||[]}
function digest(rec){
  const raw=JSON.stringify([rec.id,rec.settlement,rec.street,rec.house,rec.entrance,
    rec.pointType,rec.comment,rec.lat,rec.lng,rec.accuracyM,rec.source,rec.capturedAt]);
  let h=2166136261;
  for(let i=0;i<raw.length;i++){h=Math.imul(h^raw.charCodeAt(i),16777619)}
  return (h>>>0).toString(36)+'-'+raw.length.toString(36);
}
function pendingCount(){
  const own=localRows();
  return own.filter(r=>!operatorHiddenIds.has(r.id)&&synced[r.id]!==digest(r)).length+deletedIds.length;
}
function normalRemote(raw){
  const normalized=core.normalizeRecord(raw);
  return normalized?{...normalized,collectorName:String(raw.collectorName||'').slice(0,60)}:null;
}
function renderStatus(text,bad=false){
  const node=$('syncStatus');
  node.textContent=text;
  node.className='sync-status '+(bad?'bad':credentials?'good':'warn');
  $('syncPending').textContent='На отправку: '+pendingCount();
  $('sharedCount').textContent=total+' адресов в общей базе';
  const hidden=localRows().filter(r=>operatorHiddenIds.has(r.id)).length;
  $('syncPending').textContent+=' · скрыто диспетчером: '+hidden;
  $('syncTeamStats').replaceChildren();
  for(const line of stats.slice(0,30)){
    const row=document.createElement('div');row.className='team-stat';
    const name=document.createElement('span');name.textContent=line.name;
    const count=document.createElement('strong');count.textContent=String(line.count);
    row.append(name,count);$('syncTeamStats').appendChild(row);
  }
}
function updateMap(){
  window.SvoiCollector?.refreshShared?.();
}
function saveShared(){
  // Avoid exceeding Android WebView's localStorage quota as the team database grows.
  const data={name:credentials?.name||'',addresses:shared,stats,total};
  const json=JSON.stringify(data);
  if(json.length<1100000){try{localStorage.setItem(CACHE_KEY,json)}catch{}}
  else {try{localStorage.removeItem(CACHE_KEY)}catch{}}
}
function restoreCache(){
  const data=loadJson(CACHE_KEY,{});
  if(!credentials||data.name!==credentials.name)return;
  if(Array.isArray(data.addresses))shared=data.addresses.map(normalRemote).filter(Boolean).slice(0,10000);
  if(Array.isArray(data.stats))stats=data.stats;
  total=Number(data.total)||shared.length;
  updateMap();
}
function authHeaders(){
  return {'Accept':'application/json','Content-Type':'application/json',
    'X-Collector-Name':encodeURIComponent(credentials.name),'Authorization':'Bearer '+credentials.secret};
}
async function request(method='GET',body){
  const ctrl=new AbortController(),timeout=setTimeout(()=>ctrl.abort(),15000);
  try{
    const resp=await fetch(ENDPOINT,{method,headers:authHeaders(),mode:'cors',cache:'no-store',
      signal:ctrl.signal,...body?{body:JSON.stringify(body)}:{}});
    const result=await resp.json().catch(()=>({}));
    if(!resp.ok||!result.ok){
      const error=new Error(String(result.error||'Ошибка сети '+resp.status));
      error.status=resp.status;error.existing=result.existing;
      throw error;
    }
    return result;
  }finally{clearTimeout(timeout)}
}
function disconnect(){
  credentials=null;shared=[];stats=[];total=0;synced={};deletedIds=[];operatorHiddenIds.clear();conflicts.clear();lastSuccess=0;
  try{localStorage.removeItem(CONFIG_KEY)}catch{}
  $('collectorSecret').value='';$('syncConnection').textContent='Подключить';
  $('collectorName').disabled=false;$('collectorSecret').disabled=false;
  updateMap();renderStatus('Общая база отключена. Адреса на телефоне не удаляются.',false);
}
function loadCredentials(){
  const data=loadJson(CONFIG_KEY,{});
  if(!data||typeof data.name!=='string'||typeof data.secret!=='string'||data.secret.length<24)return;
  credentials={name:data.name,secret:data.secret};
  $('collectorName').value=credentials.name;
  $('collectorSecret').value=credentials.secret;
}
function onConnected(){
  $('syncConnection').textContent='Отключить';
  $('collectorName').disabled=true;$('collectorSecret').disabled=true;
  synced=loadJson(SYNC_KEY+':'+credentials.name,{});
  deletedIds=loadJson(DELETE_KEY+':'+credentials.name,[]);
  if(!Array.isArray(deletedIds))deletedIds=[];
  const previouslyHidden=loadJson(OPERATOR_HIDDEN_KEY+':'+credentials.name,[]);
  operatorHiddenIds=new Set(Array.isArray(previouslyHidden)?previouslyHidden.filter(id=>typeof id==='string').slice(0,10000):[]);
  if(!synced||typeof synced!=='object'||Array.isArray(synced))synced={};
  restoreCache();
  renderStatus('Подключаемся к общей базе…');
  scheduleSync();
}
function connect(){
  if(credentials){disconnect();return}
  const name=$('collectorName').value.trim(),secret=$('collectorSecret').value.trim();
  if(!name||name.length>60||secret.length<24){
    renderStatus('Введите своё имя и выданный руководителем ключ (не короче 24 символов).',true);
    return;
  }
  credentials={name,secret};
  if(!writeJson(CONFIG_KEY,credentials)){
    credentials=null;renderStatus('Не удалось сохранить данные подключения на телефоне.',true);
    return;
  }
  onConnected();
}
function persistState(){
  if(!writeJson(SYNC_KEY+':'+credentials.name,synced)||!writeJson(DELETE_KEY+':'+credentials.name,deletedIds)||
    !writeJson(OPERATOR_HIDDEN_KEY+':'+credentials.name,[...operatorHiddenIds])){
    renderStatus('Внимание: список отправленных точек не сохраняется. Освободите память.',true);
    return false;
  }
  return true;
}
async function pull(){
  const data=await request();
  if(!Array.isArray(data.addresses)||!Array.isArray(data.stats))throw Error('Неверный ответ общей базы');
  shared=data.addresses.map(normalRemote).filter(Boolean).slice(0,10000);
  stats=data.stats.map(x=>({name:String(x.name||'').slice(0,60),count:Number(x.count)||0}));
  total=Number(data.total)||0;
  // The server is authoritative only when the full active list was returned.
  // No destructive operation: original phone records stay in localStorage/GeoJSON.
  // Previously uploaded IDs absent from this complete server snapshot were removed
  // by the dispatcher (or are otherwise no longer active on the shared map).
  // The 10,000-address API cap must never cause false local hiding.
  if(total===shared.length){
    const active=new Set(shared.map(record=>record.id));
    let changed=false;
    for(const rec of localRows()){
      if(!synced[rec.id]||deletedIds.includes(rec.id))continue;
      if(!active.has(rec.id)&&!operatorHiddenIds.has(rec.id)){
        operatorHiddenIds.add(rec.id);changed=true;
      }else if(active.has(rec.id)&&operatorHiddenIds.delete(rec.id)){
        changed=true;
      }
    }
    if(changed)persistState();
  }
  saveShared();updateMap();
}
async function push(){
  if(!window.SvoiCollector?.localStorageHealthy?.())throw Error('Локальная база повреждена. Отправка заблокирована.');
  const own=localRows();
  const localIds=new Set(own.map(r=>r.id));
  for(const id of [...deletedIds]){
    if(!localIds.has(id))await request('DELETE',{id});
    deletedIds=deletedIds.filter(x=>x!==id);
    delete synced[id];persistState();
  }
  for(const record of own){
    // An operator-deleted local copy must not be uploaded again.
    if(operatorHiddenIds.has(record.id))continue;
    const hash=digest(record);
    if(synced[record.id]===hash)continue;
    const lastConflict=conflicts.get(record.id);
    if(lastConflict?.hash===hash&&shared.some(remote=>core.key(remote)===core.key(record)))continue;
    try{
      const result=await request('POST',{record});
      // The backend returns {deleted:true} for the same historical ID.
      // Honour that response instead of falsely reporting it as uploaded.
      if(result.deleted===true){
        operatorHiddenIds.add(record.id);
      }else{
        synced[record.id]=hash;
      }
      conflicts.delete(record.id);
      persistState();
    }catch(error){
      if(error.status===409){
        conflicts.set(record.id,{hash,existing:error.existing});
        continue;
      }
      throw error;
    }
  }
}
async function synchronize(){
  if(!credentials)return;
  if(running){queued=true;return}
  if(!navigator.onLine){offline=true;renderStatus('Нет интернета. Новые точки остаются на телефоне.',true);return}
  running=true;
  try{
    renderStatus('Обновляем общую карту…');
    await pull();
    await push();
    await pull();
    offline=false;lastSuccess=Date.now();
    const pending=pendingCount();
    if(conflicts.size){
      renderStatus('Есть '+conflicts.size+' совпадений с общей базой. Проверьте эти адреса — повторно они не загружены.',true);
    }else if(pending){
      renderStatus('Синхронизация неполная: '+pending+' точек осталось на отправку.',true);
    }else renderStatus('Синхронизировано · обновлено '+new Date(lastSuccess).toLocaleTimeString('ru-RU'));
  }catch(error){
    const message=error.status===401?'Неверный ключ доступа или имя сборщика.':
      error.status===503?'Общий сервер недоступен. Локальные точки сохранены.':
      'Связь с общей базой не установлена. Локальные точки сохранены.';
    renderStatus(message+' '+String(error?.message||'').slice(0,100),true);
  }finally{
    running=false;
    if(queued){queued=false;setTimeout(synchronize,400)}
  }
}
function scheduleSync(){
  if(!credentials)return;
  if(timer)clearTimeout(timer);
  timer=setTimeout(()=>{timer=null;synchronize()},300);
}
function onLocalChanged(){
  if(credentials){
    renderStatus('Адрес сохранён на телефоне. Ожидает отправки в общую базу.');
    scheduleSync();
  }
}
function onLocalDeleted(id){
  if(!credentials||typeof id!=='string')return;
  if(!deletedIds.includes(id))deletedIds.push(id);
  // Hide the local/remote duplicate immediately, even if offline.
  // Keep the explicit deletion queued until the server acknowledges it.
  shared=shared.filter(record=>record.id!==id);
  saveShared();
  persistState();
  updateMap();
  scheduleSync();
}
function getSharedRows(){return shared.filter(record=>!deletedIds.includes(record.id))}
function isLocalHidden(id){return operatorHiddenIds.has(id)}
function isConflict(id){return conflicts.has(id)}
$('syncConnection').addEventListener('click',connect);
$('syncNow').addEventListener('click',()=>{
  if(!credentials){renderStatus('Сначала подключите общий сбор.',true);return}
  synchronize();
});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&credentials)scheduleSync()});
window.addEventListener('online',()=>{if(credentials)scheduleSync()});
window.SvoiTeamSync=Object.freeze({getSharedRows,isLocalHidden,onLocalChanged,onLocalDeleted,isConflict});
loadCredentials();
if(credentials)onConnected();
else renderStatus('Общая база не подключена. Можно продолжать сбор на этом телефоне.');
setInterval(()=>{if(!document.hidden&&credentials)synchronize()},20000);
})();
