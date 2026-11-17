import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const coreSource=read('android-driver/address-collector/src/main/assets/address-core.js');
const collectorSource=read('android-driver/address-collector/src/main/assets/collector.js');
const activity=read('android-driver/address-collector/src/main/java/ru/svoitaxi/addresscollector/CollectorActivity.java');
function module(){
  const context=vm.createContext({console});
  vm.runInContext(coreSource,context,{timeout:1500});
  return context.SvoiAddressCore;
}
const sample=(overrides={})=>({
  id:'a1',settlement:'Агинское',street:'Ленина',house:'15А',entrance:'',pointType:'дом',
  lat:55.2586,lng:94.9079,accuracyM:7,source:'gps',capturedAt:'2026-11-14T08:00:00.000Z',comment:'',
  ...overrides
});
test('address collector has an isolated APK id and no driver login/line permissions',()=>{
  const manifest=read('android-driver/address-collector/src/main/AndroidManifest.xml');
  const build=read('android-driver/address-collector/build.gradle.kts');
  assert.match(build,/applicationId = "ru\.svoitaxi\.addresscollector\.preview"/);
  assert.doesNotMatch(build,/applicationId = "ru\.svoitaxi\.driver"/);
  assert.match(manifest,/ACCESS_FINE_LOCATION/);
  assert.doesNotMatch(manifest,/POST_NOTIFICATIONS|FOREGROUND_SERVICE|MESSAGING_EVENT|DriverLocationService/);
  assert.doesNotMatch(activity,/driver\.svoi-taxi24\.ru|ACTION_VIEW|FirebaseMessaging/);
  assert.match(activity,/WebViewAssetLoader/);
  assert.match(activity,/WebSettings\.MIXED_CONTENT_NEVER_ALLOW/);
});
test('GPS pairs are valid only in geographic range and cannot be null island',()=>{
  const m=module();
  assert.equal(m.validPair(55.25,94.90),true);
  assert.equal(m.validPair(0,0),false);
  assert.equal(m.validPair(null,94.90),false);
  assert.equal(m.validPair(95,94),false);
  assert.equal(m.validPair(55,181),false);
  assert.equal(m.validPair('',94),false);
});
test('address normalization requires house street settlement and coordinates',()=>{
  const m=module();
  assert.equal(m.normalizeRecord(sample({street:''})),null);
  assert.equal(m.normalizeRecord(sample({house:''})),null);
  assert.equal(m.normalizeRecord(sample({settlement:''})),null);
  assert.equal(m.normalizeRecord(sample({lat:'invalid'})),null);
  const record=m.normalizeRecord(sample());
  assert.equal(record.street,'Ленина');
  assert.equal(record.house,'15А');
  assert.equal(record.lat,55.2586);
  assert.equal(record.lng,94.9079);
  assert.equal(record.accuracyM,7);
});
test('map-defined address never invents GPS measurement accuracy',()=>{
  const m=module();
  const r=m.normalizeRecord(sample({source:'map',accuracyM:null}));
  assert.equal(r.accuracyM,null);
  assert.equal(r.source,'map');
});
test('duplicate key includes street house settlement point type and entrance',()=>{
  const m=module();
  const a=m.normalizeRecord(sample()),b=m.normalizeRecord(sample({id:'b2',street:'ленина',house:'15а'}));
  assert.equal(m.findDuplicate([a],b).id,'a1');
  assert.equal(m.findDuplicate([a],m.normalizeRecord(sample({id:'b',house:'16'}))),null);
  assert.equal(m.findDuplicate([a],m.normalizeRecord(sample({id:'b',pointType:'въезд'}))),null);
});
test('GeoJSON export contains only verified coordinates, address metadata and no session identifiers',()=>{
  const m=module();const d=m.toGeoJson([m.normalizeRecord(sample())]);
  assert.equal(d.type,'FeatureCollection');
  assert.equal(d.schema,'svoi-address-collector-v1');
  assert.equal(d.features.length,1);
  assert.deepEqual(Array.from(d.features[0].geometry.coordinates),[94.9079,55.2586]);
  assert.equal(d.features[0].properties.house,'15А');
  assert.doesNotMatch(JSON.stringify(d),/password|cookie|token|clientPhone|commission|vehicleId/);
});
test('GeoJSON roundtrip restores address points without duplicates',()=>{
  const m=module();const a=m.normalizeRecord(sample()),b=m.normalizeRecord(sample({id:'a2',house:'16'}));
  const file=JSON.stringify(m.toGeoJson([a,b]));
  const imported=m.parseGeoJson(file);
  assert.equal(imported.length,2);
  const merge=m.mergeRecords([a],imported);
  assert.equal(merge.added,1);
  assert.equal(merge.skipped,1);
  assert.equal(merge.rows.length,2);
});
test('GeoJSON import safely rejects invalid files and ignores unusable coordinates',()=>{
  const m=module();
  assert.throws(()=>m.parseGeoJson('<xml>test</xml>'),/GeoJSON/);
  assert.throws(()=>m.parseGeoJson('{"type":"Point","coordinates":[94,55]}'),/FeatureCollection/);
  const bad={type:'FeatureCollection',features:[
    {type:'Feature',geometry:{type:'Point',coordinates:[94,95]},properties:sample()},
    {type:'Feature',geometry:{type:'Point',coordinates:[94,55]},properties:sample({id:'valid'})}
  ]};
  const res=m.parseGeoJson(JSON.stringify(bad));assert.equal(res.length,1);assert.equal(res[0].id,'valid');
  assert.throws(()=>m.parseGeoJson('x'.repeat(8000001)),/слишком большой/);
});
test('CSV export encodes quotes, semicolons, newlines and spreadsheet formula injection',()=>{
  const m=module();
  const row=m.normalizeRecord(sample({street:'Ленина; "дом"',comment:'=1+1'}));
  const csv=m.toCsv([row]);
  assert.match(csv,/^\uFEFFid;settlement;street/);
  assert.match(csv,/"Ленина; ""дом"""/);
  assert.match(csv,/"'=1\+1"/);
  assert.equal(csv.includes('\r\n'),true);
});
test('import caps 10,000 entries and never overwrites matching address or matching id',()=>{
  const m=module();
  const a=m.normalizeRecord(sample()),b=m.normalizeRecord(sample({id:'a1',house:'16'})),c=m.normalizeRecord(sample({id:'c',house:'15А'}));
  const out=m.mergeRecords([a],[b,c]);
  assert.equal(out.added,0);
  assert.equal(out.skipped,2);
});
test('collector stores data only on phone and includes GPS stale, accuracy, movement and backup checks',()=>{
  assert.match(collectorSource,/localStorage\.setItem/);
  assert.match(collectorSource,/watchPosition/);
  assert.match(collectorSource,/clearWatch/);
  assert.match(collectorSource,/Date\.now\(\)-gps\.at>30000/);
  assert.match(collectorSource,/gps\.speed>1\.5/);
  assert.match(collectorSource,/chosen\.accuracyM>30/);
  assert.match(collectorSource,/core\.findDuplicate/);
  assert.match(collectorSource,/CollectorNative\.exportGeoJson/);
  assert.match(collectorSource,/CollectorNative\.importGeoJson/);
  assert.match(collectorSource,/getSource\('svoi-house-collection'\)/);
  assert.doesNotMatch(collectorSource,/\/api\/orders|\/api\/driver-tasks|\/api\/order-status|\/api\/order-accept/);
});
test('native Android uses SAF document export and import without requesting file storage permissions',()=>{
  assert.match(activity,/Intent\.ACTION_CREATE_DOCUMENT/);
  assert.match(activity,/Intent\.ACTION_OPEN_DOCUMENT/);
  assert.match(activity,/@JavascriptInterface/);
  assert.match(activity,/MAX_EXPORT_BYTES/);
  assert.match(activity,/JSONObject\.quote\(json\)/);
  const manifest=read('android-driver/address-collector/src/main/AndroidManifest.xml');
  assert.doesNotMatch(manifest,/READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE|MANAGE_EXTERNAL_STORAGE/);
});

test('native Android GPS bridge requests both runtime permissions and location providers',()=>{
  assert.match(activity,/LocationManager/);
  assert.match(activity,/LocationManager\.GPS_PROVIDER/);
  assert.match(activity,/LocationManager\.NETWORK_PROVIDER/);
  assert.match(activity,/requestLocationUpdates\(/);
  assert.match(activity,/requestPermissions\(new String\[\]\{Manifest\.permission\.ACCESS_FINE_LOCATION/);
  assert.match(activity,/locationListener/);
  assert.match(activity,/onLocationChanged\(Location location\)/);
  assert.match(activity,/window\.SvoiCollector&&window\.SvoiCollector\.onNativeLocation/);
  assert.match(activity,/window\.SvoiCollector&&window\.SvoiCollector\.onNativeStatus/);
  assert.match(activity,/void openGpsSettings\(\)/);
  assert.match(activity,/Settings\.ACTION_LOCATION_SOURCE_SETTINGS/);
  assert.doesNotMatch(activity,/new WebChromeClient|onGeolocationPermissionsShowPrompt/);
});
test('native GPS is foreground-only and reports denied, disabled and acquisition timeout',()=>{
  assert.match(activity,/onPause\(\)\{[\s\S]*stopNativeLocation/);
  assert.match(activity,/onDestroy\(\)\{[\s\S]*stopNativeLocation/);
  assert.match(activity,/sendStatus\("denied"/);
  assert.match(activity,/sendStatus\("disabled"/);
  assert.match(activity,/sendStatus\("timeout"/);
  assert.match(activity,/sendStatus\("permission"/);
  assert.match(activity,/lastFixAt/);
  const manifest=read('android-driver/address-collector/src/main/AndroidManifest.xml');
  assert.doesNotMatch(manifest,/ACCESS_BACKGROUND_LOCATION|FOREGROUND_SERVICE/);
});
test('collector native JS persists accurate GPS measurement and exposes retry/settings controls',()=>{
  const html=read('android-driver/address-collector/src/main/assets/collector.html');
  assert.match(html,/id="gpsDiagnostic"/);
  assert.match(html,/id="retryGps"/);
  assert.match(html,/id="gpsSettings"/);
  assert.match(collectorSource,/CollectorNative\.startLocation\(\)/);
  assert.match(collectorSource,/CollectorNative\.retryLocation\(\)/);
  assert.match(collectorSource,/CollectorNative\.stopLocation\(\)/);
  assert.match(collectorSource,/CollectorNative\.openGpsSettings\(\)/);
  assert.match(collectorSource,/function onNativeLocation\(payload\)/);
  assert.match(collectorSource,/function onNativeStatus\(payload\)/);
  assert.match(collectorSource,/quality\.normalizeFix\(payload\)/);
  assert.match(read('android-driver/address-collector/src/main/assets/gps-quality.js'),/now-at>90000/);
  assert.match(collectorSource,/accuracyM>30/);
  assert.match(collectorSource,/onNativeLocation,onNativeStatus/);
  assert.doesNotMatch(collectorSource,/\/api\/orders|\/api\/order-status|\/api\/driver-tasks/);
});

test('GPS quality filter rejects impossible, stale and invalid Android locations',()=>{
  const context=vm.createContext({console});
  vm.runInContext(read('android-driver/address-collector/src/main/assets/gps-quality.js'),context,{timeout:1500});
  const q=context.SvoiGpsQuality,now=1794660000000;
  assert.equal(q.normalizeFix({lat:95,lng:94,at:now,accuracyM:5},now),null);
  assert.equal(q.normalizeFix({lat:55,lng:94,at:now-95000,accuracyM:5},now),null);
  assert.equal(q.normalizeFix({lat:55,lng:94,at:now,accuracyM:-3},now),null);
  assert.equal(q.normalizeFix({lat:55,lng:94,at:now,accuracyM:5,provider:'gps',speed:null},now).speed,null);
});
test('fresh satellite fix must not be displaced by network coordinate or worse satellite reading',()=>{
  const context=vm.createContext({console});
  vm.runInContext(read('android-driver/address-collector/src/main/assets/gps-quality.js'),context,{timeout:1500});
  const q=context.SvoiGpsQuality,now=1794660000000;
  const fix=(accuracyM,provider,at=now)=>q.normalizeFix({lat:55.2586,lng:94.9079,accuracyM,provider,at},now);
  assert.equal(q.shouldShowFix(fix(6,'gps'),fix(12,'network'),now),false);
  assert.equal(q.shouldShowFix(fix(6,'gps'),fix(35,'gps'),now),false);
  assert.equal(q.shouldShowFix(fix(20,'network'),fix(8,'gps'),now),true);
  assert.equal(q.shouldShowFix(fix(15,'gps',now-26000),fix(25,'network'),now),true);
});
test('30-second precision collector uses only stationary eligible satellite fixes and keeps smallest accuracy',()=>{
  const context=vm.createContext({console});
  vm.runInContext(read('android-driver/address-collector/src/main/assets/gps-quality.js'),context,{timeout:1500});
  const q=context.SvoiGpsQuality,now=1794660000000;
  const fix=(accuracyM,provider,speed=0.1,at=now)=>q.normalizeFix({lat:55.2586,lng:94.9079,accuracyM,provider,speed,at},now);
  assert.equal(q.bestPrecisionFix(null,fix(4,'network'),now),null);
  assert.equal(q.bestPrecisionFix(null,fix(40,'gps'),now),null);
  assert.equal(q.bestPrecisionFix(null,fix(4,'gps',3),now),null);
  assert.equal(q.bestPrecisionFix(null,fix(4,'gps',0.1,now-3000),now),null);
  const good=fix(12,'gps');
  assert.equal(q.bestPrecisionFix(null,good,now),good);
  assert.equal(q.bestPrecisionFix(good,fix(19,'gps'),now),good);
  assert.equal(q.bestPrecisionFix(good,fix(5,'gps'),now).accuracyM,5);
});
test('precision controls and actual APK include GPS quality code with no production endpoint access',()=>{
  const html=read('android-driver/address-collector/src/main/assets/collector.html');
  assert.match(html,/src="\/gps-quality\.js"/);
  assert.match(html,/id="precisionBtn"/);
  assert.match(html,/id="precisionInfo"/);
  assert.match(collectorSource,/bestPrecisionFix/);
  assert.match(collectorSource,/shouldShowFix/);
  assert.match(collectorSource,/onNativeLocation/);
  assert.match(collectorSource,/function stopPrecision/);
  assert.match(collectorSource,/function beginPrecision/);
  assert.match(collectorSource,/source:'gps'/);
  assert.doesNotMatch(collectorSource,/\/api\/orders|\/api\/order-status|\/api\/order-accept/);
});

test('saved houses are green with visible address numbers, while draft pin remains yellow',()=>{
  const html=read('android-driver/address-collector/src/main/assets/collector.html');
  assert.match(collectorSource,/['"]circle-color['"]:'\#25cf86'/);
  assert.match(collectorSource,/function renderHouseNumbers\(\)/);
  assert.match(collectorSource,/className='collector-house-number'/);
  assert.match(collectorSource,/element\.textContent=label/);
  assert.match(collectorSource,/f\.properties\.label=f\.properties\.house/);
  assert.match(collectorSource,/background:#ffd331/);
  assert.match(html,/Зелёные — сохранены/);
  assert.match(html,/Жёлтая метка — выбранная точка до сохранения/);
  assert.match(html,/Синяя — GPS телефона/);
});
test('save success clears the draft yellow marker, but does not clear on failed persist',()=>{
  const source=collectorSource;
  assert.match(source,/function clearForm\(\)\{[\s\S]*?chosen=null;[\s\S]*?drawChosen\(\);/);
  assert.match(source,/if\(!chosen\)\{chosenMarker\?\.remove\(\);chosenMarker=null;return\}/);
  assert.match(source,/if\(!persist\(updated\)\)return showSaveFeedback/);
  assert.match(source,/clearForm\(\); \/\/ Draft yellow marker removed/);
  assert.match(source,/const source=map\.getSource\('svoi-house-collection'\);[\s\S]*?source\.setData\(savedGeo\(\)\)/);
});
