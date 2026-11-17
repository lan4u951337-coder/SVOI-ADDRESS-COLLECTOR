/* СВОИ ТАКСИ: pure address data conversion / verification. No network. */
(function(root){
'use strict';
const MAX_RECORDS=10000, MAX_FIELD=240;
const text=(value,max=MAX_FIELD)=>String(value??'').replace(/[\u0000-\u001f]/g,' ').trim().slice(0,max);
function normalizedCoordinate(raw,axis){
  if(raw==null||raw==='')return null;
  const n=Number(raw);
  const bound=axis==='lat'?90:180;
  return Number.isFinite(n)&&Math.abs(n)<=bound?n:null;
}
function validPair(lat,lng){
  const a=normalizedCoordinate(lat,'lat'),b=normalizedCoordinate(lng,'lng');
  return a!==null&&b!==null&&!(a===0&&b===0);
}
function normalizeRecord(input){
  if(!input||typeof input!=='object'||Array.isArray(input))return null;
  const lat=normalizedCoordinate(input.lat,'lat'),lng=normalizedCoordinate(input.lng,'lng');
  const settlement=text(input.settlement,120),street=text(input.street,160),house=text(input.house,50);
  if(!settlement||!street||!house||!validPair(lat,lng))return null;
  const type=['дом','вход','въезд'].includes(input.pointType)?input.pointType:'дом';
  const hasAccuracy=input.accuracyM!==null&&input.accuracyM!==undefined&&input.accuracyM!=='';
  const accuracyRaw=hasAccuracy?Number(input.accuracyM):NaN;
  const accuracyM=Number.isFinite(accuracyRaw)&&accuracyRaw>=0&&accuracyRaw<=100000?Math.round(accuracyRaw*10)/10:null;
  const source=['gps','map'].includes(input.source)?input.source:'gps';
  const capturedAt=Number.isFinite(Date.parse(input.capturedAt))?new Date(input.capturedAt).toISOString():new Date().toISOString();
  const id=text(input.id,80)||('addr-'+capturedAt.replace(/[^0-9]/g,'')+'-'+Math.random().toString(36).slice(2,10));
  return {id,settlement,street,house,entrance:text(input.entrance,50),pointType:type,comment:text(input.comment,500),
    lat,lng,accuracyM,source,capturedAt};
}
function key(r){
  return [r.settlement,r.street,r.house,r.pointType,r.pointType==='дом'?'':r.entrance].map(x=>text(x).normalize('NFKC').toLocaleLowerCase('ru').replace(/\s+/g,' ')).join('|');
}
function findDuplicate(rows,record){
  const k=key(record);return rows.find(row=>key(row)===k)||null;
}
function toGeoJson(rows){
  return {
    type:'FeatureCollection',
    name:'СВОИ ТАКСИ — координаты адресов',
    schema:'svoi-address-collector-v1',
    exportedAt:new Date().toISOString(),
    features:rows.filter(Boolean).map(r=>({
      type:'Feature',id:r.id,
      geometry:{type:'Point',coordinates:[r.lng,r.lat]},
      properties:{id:r.id,settlement:r.settlement,street:r.street,house:r.house,entrance:r.entrance,
        pointType:r.pointType,comment:r.comment,accuracyM:r.accuracyM,source:r.source,capturedAt:r.capturedAt}
    }))
  };
}
function csvCell(value){
  let v=String(value??'');
  if(/^[\s]*[=+\-@\t\r]/u.test(v))v="'"+v;
  return '"'+v.replace(/"/g,'""')+'"';
}
const COLUMNS=['id','settlement','street','house','entrance','pointType','lat','lng','accuracyM','source','comment','capturedAt'];
function toCsv(rows){
  return '\uFEFF'+COLUMNS.join(';')+'\r\n'+rows.map(row=>COLUMNS.map(k=>csvCell(row[k])).join(';')).join('\r\n')+'\r\n';
}
function parseGeoJson(content){
  if(typeof content!=='string'||content.length>8000000)throw Error('Файл слишком большой');
  let doc;
  try{doc=JSON.parse(content)}catch{throw Error('Это не файл GeoJSON')}
  if(!doc||doc.type!=='FeatureCollection'||!Array.isArray(doc.features))throw Error('Нужен GeoJSON FeatureCollection');
  if(doc.features.length>MAX_RECORDS)throw Error('Слишком много точек в файле');
  const rows=[];
  for(const f of doc.features){
    if(f?.type!=='Feature'||f.geometry?.type!=='Point'||!Array.isArray(f.geometry?.coordinates))continue;
    const p=f.properties||{},coord=f.geometry.coordinates;
    const rec=normalizeRecord({...p,id:p.id||f.id,lng:coord[0],lat:coord[1]});
    if(rec)rows.push(rec);
  }
  return rows;
}
function mergeRecords(existing,incoming){
  const rows=existing.slice(),keys=new Set(rows.map(key)),ids=new Set(rows.map(x=>x.id));
  let added=0,skipped=0;
  for(const row of incoming){
    const record=normalizeRecord(row);
    if(!record||keys.has(key(record))||ids.has(record.id)||rows.length>=MAX_RECORDS){skipped++;continue}
    rows.push(record);keys.add(key(record));ids.add(record.id);added++;
  }
  return {rows,added,skipped};
}
root.SvoiAddressCore=Object.freeze({normalizeRecord,validPair,findDuplicate,toGeoJson,toCsv,parseGeoJson,mergeRecords,key,MAX_RECORDS});
})(typeof window!=='undefined'?window:globalThis);
