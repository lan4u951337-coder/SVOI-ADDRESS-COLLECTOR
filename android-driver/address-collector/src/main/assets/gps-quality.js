/* СВОИ ТАКСИ · quality filter for field GPS fixes. Pure, no network or permissions. */
(function(root){
'use strict';
const validCoordinate=(lat,lng)=>
  Number.isFinite(lat)&&Number.isFinite(lng)&&Math.abs(lat)<=90&&Math.abs(lng)<=180&&!(lat===0&&lng===0);
function normalizeFix(input,now=Date.now()){
  if(!input||typeof input!=='object')return null;
  const lat=Number(input.lat),lng=Number(input.lng),at=Number(input.at);
  const accuracyM=Number(input.accuracyM);
  if(!validCoordinate(lat,lng)||!Number.isFinite(at)||at>now+10000||now-at>90000||
     !Number.isFinite(accuracyM)||accuracyM<0||accuracyM>100000)return null;
  const rawSpeed=input.speed;
  const speed=rawSpeed===null||rawSpeed===undefined||rawSpeed===''?null:Number(rawSpeed);
  return Object.freeze({lat,lng,accuracyM,at,
    speed:Number.isFinite(speed)&&speed>=0?speed:null,
    provider:input.provider==='gps'?'gps':'network'});
}
function shouldShowFix(previous,next,now=Date.now()){
  if(!next)return false;
  if(!previous)return true;
  const currentAge=now-previous.at;
  if(currentAge>25000)return true;
  if(previous.provider==='gps'&&next.provider!=='gps')return false;
  if(previous.provider!=='gps'&&next.provider==='gps')return true;
  // A worse network/satellite estimate must not displace a fresh good fix.
  return next.accuracyM<=previous.accuracyM*1.35;
}
function bestPrecisionFix(previous,next,startedAt){
  if(!next||next.provider!=='gps'||next.at<startedAt-1000||
     next.accuracyM>35||next.speed!==null&&next.speed>1.1)return previous||null;
  if(!previous||next.accuracyM<previous.accuracyM)return next;
  return previous;
}
root.SvoiGpsQuality=Object.freeze({normalizeFix,shouldShowFix,bestPrecisionFix});
})(typeof window!=='undefined'?window:globalThis);
