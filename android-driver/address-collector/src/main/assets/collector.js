/* СВОИ ТАКСИ · автономный полевой сбор адресов. Без серверных запросов и водителей. */
(()=>{
'use strict';
if(window.SvoiCollector)return;
const core=window.SvoiAddressCore, quality=window.SvoiGpsQuality;
const KEY='svoi.addressCollector.records.v1',CENTER=[94.9079,55.2586];
const $=id=>document.getElementById(id);
let rows=[],gps=null,watch=null,chosen=null,editId=null,manualMode=false,storageBlocked=false;
let pendingDeleteId=null,pendingDeleteUntil=0;
let nativeActive=false,gpsStatus='Запрашиваем координаты телефона…',gpsStatusKind='warn';
let precision=null;
let map=null,gpsMarker=null,chosenMarker=null,mapLoaded=false,lastMapError=0;
let alertTimer=null,lowAccuracyArmed=false;
let updatePromptVersion='',updateDismissedVersion='',lastUpdateCheckAt=0;
const numberMarkers=new Map(),MAX_NUMBER_MARKERS=220;
function msg(text){
  $('notice').textContent=text;
  clearTimeout(alertTimer);
  alertTimer=setTimeout(()=>{$('notice').textContent=''},12000);
}
function clearSaveFeedback(){
  for(const id of ['saveFeedback','mapSaveFeedback']){
    const node=$(id);node.textContent='';node.hidden=true;node.className='save-feedback';
  }
  for(const id of ['settlement','street','house'])$(id).removeAttribute('aria-invalid');
}
function showSaveFeedback(message,kind='bad',fieldId=''){
  for(const id of ['saveFeedback','mapSaveFeedback']){
    const node=$(id);node.textContent=message;node.hidden=false;
    node.className='save-feedback '+kind;
  }
  if(fieldId)$(fieldId).setAttribute('aria-invalid','true');
}
function onUpdateStatus(payload){
  if(!payload||typeof payload!=='object')return;
  const state=String(payload.state||'');
  const message=String(payload.message||'Проверка обновлений завершена.');
  const version=String(payload.version||'');
  $('updateInfo').textContent=message;
  $('installUpdate').hidden=!['available','ready','permission','downloading'].includes(state);
  $('installUpdate').disabled=state==='downloading'||state==='checking';
  $('installUpdate').textContent=state==='permission'?'Продолжить обновление':
    state==='downloading'?'Загружаем APK…':'Обновить приложение';
  $('checkForUpdates').disabled=state==='checking'||state==='downloading';

  // Native Android verifies that the release is strictly newer before reporting "available".
  // The prompt must not appear for an up-to-date version or a network error.
  if(state==='available'&&/^v\\d+\\.\\d+\\.\\d+$/.test(version)&&
      version!==updateDismissedVersion&&version!==updatePromptVersion){
    updatePromptVersion=version;
    $('updateDialogDescription').textContent='Доступна новая версия '+version.slice(1)+' сборщика адресов.';
    $('updateDialogStatus').textContent='Ваши собранные адреса и ключ доступа сохранятся.';
    $('updateDialogInstall').textContent='Обновить';
    $('updateDialogInstall').disabled=false;
    $('updateDialogLater').disabled=false;
    $('updateDialog').hidden=false;
    $('updateDialogInstall').focus();
  }
  if(!$('updateDialog').hidden){
    $('updateDialogStatus').textContent=state==='downloading'?'Загрузка обновления…':
      state==='permission'?'Разрешите установку из СВОИ в настройках Android и нажмите «Обновить» ещё раз.':
      state==='ready'?'APK проверен. Подтвердите установку в Android.':
      message.startsWith('Не удалось загрузить')?message:
      'Ваши собранные адреса и ключ доступа сохранятся.';
    $('updateDialogInstall').disabled=state==='downloading'||state==='checking';
    $('updateDialogInstall').textContent=state==='downloading'?'Загружаем…':
      state==='permission'?'Продолжить':'Обновить';
    // Avoid showing a cancel button which would leave a downloading APK installing later.
    $('updateDialogLater').disabled=state==='downloading';
  }
  if(state==='current'||state==='error'){
    $('updateDialog').hidden=true;
    updatePromptVersion='';
  }
}
function safeLoad(){
  try{
    const raw=localStorage.getItem(KEY);
    if(!raw)return [];
    const parsed=JSON.parse(raw);
    if(!Array.isArray(parsed))throw Error('Invalid saved data');
    return parsed.map(core.normalizeRecord).filter(Boolean);
  }catch{
    storageBlocked=true;
    $('notice').textContent='Ошибка чтения хранилища. Новые адреса не будут перезаписывать повреждённые данные. Сохраните данные и обратитесь к разработчику.';
    return [];
  }
}
function persist(next){
  if(storageBlocked){msg('Хранилище не удалось прочитать. Запись заблокирована во избежание потери данных.');return false}
  if(next.length>core.MAX_RECORDS){msg('Лимит локальной базы 10 000 точек. Сначала выгрузите собранные адреса.');return false}
  try{localStorage.setItem(KEY,JSON.stringify(next));rows=next;render();refreshMapPoints();window.SvoiTeamSync?.onLocalChanged?.();return true}
  catch{msg('Ошибка сохранения на телефоне. Освободите память и выгрузите резервную копию.');return false}
}
function gpsText(p){
  return p.lat.toFixed(6)+', '+p.lng.toFixed(6);
}
function setBadge(message,quality){
  const node=$('gpsBadge');node.textContent=message;
  node.className='tag '+(quality||'');
}
function updateGpsPanel(){
  $('gpsDiagnostic').textContent=gpsStatus;
  $('gpsDiagnostic').className='gps-diagnostic '+gpsStatusKind;
  if(!gps){$('gpsReadout').textContent='Координаты ещё не получены.';setBadge('GPS: поиск','warn');return}
  const age=Math.max(0,Date.now()-gps.at);
  const quality=gps.accuracyM<=20&&age<30000?'good':gps.accuracyM<=40&&age<30000?'warn':'bad';
  $('gpsReadout').textContent=gpsText(gps)+' · погрешность ±'+Math.round(gps.accuracyM)+' м · '+(gps.provider==='gps'?'спутниковый GPS':'по сети')+' · обновлено '+Math.round(age/1000)+' сек. назад'+(gps.speed>1.5?' · телефон движется':'')+(age>30000?' · требуется обновление GPS':'');
  setBadge('GPS ±'+Math.round(gps.accuracyM)+' м',quality);
}
function onNativeLocation(payload){
  const next=quality.normalizeFix(payload);
  if(!next)return;
  if(precision){
    precision.count++;
    const candidate=quality.bestPrecisionFix(precision.best,next,precision.startedAt);
    if(candidate!==precision.best)precision.best=candidate;
    renderPrecision();
  }
  if(!quality.shouldShowFix(gps,next))return;
  gps=next;
  gpsStatus=next.accuracyM>30?'Точность GPS пока недостаточна. Остановитесь на открытом месте, затем нажмите «Уточнить GPS».':
    next.provider==='gps'?'Спутниковая точка получена. Для дома проверьте метку и при необходимости поправьте вручную.':
    'Пока доступна координата по сети. Ждём более точный сигнал спутников GPS.';
  gpsStatusKind=next.accuracyM>30?'warn':'good';
  updateGpsPanel();moveGpsMarker();
}
function onNativeStatus(payload){
  if(!payload)return;
  gpsStatus=String(payload.message||'Ищем координаты…');
  gpsStatusKind=['denied','permission','disabled','unavailable','timeout'].includes(payload.code)?'bad':'warn';
  if(payload.code==='denied'||payload.code==='permission')setBadge('GPS: разрешение','bad');
  else if(payload.code==='disabled')setBadge('GPS: выключен','bad');
  else if(payload.code==='timeout')setBadge('GPS: долго','bad');
  updateGpsPanel();
}
function geoWatch(){
  if(window.CollectorNative?.startLocation){
    if(nativeActive)return;
    nativeActive=true;
    gpsStatus='Запускаем Android GPS и проверяем разрешения…';gpsStatusKind='warn';updateGpsPanel();
    try{window.CollectorNative.startLocation();return}
    catch{nativeActive=false;gpsStatus='Ошибка запуска Android GPS';gpsStatusKind='bad';updateGpsPanel()}
    return;
  }
  if(watch!==null||!navigator.geolocation)return;
  try{
    watch=navigator.geolocation.watchPosition(
      pos=>{
        const c=pos?.coords||{};
        if(!core.validPair(c.latitude,c.longitude))return;
        gps={lat:Number(c.latitude),lng:Number(c.longitude),accuracyM:Number(c.accuracy)||10000,
          at:Number(pos.timestamp)||Date.now(),speed:Number.isFinite(c.speed)&&c.speed>=0?c.speed:null};
        gpsStatus='Координаты получены от WebView. Для Android используется отдельный GPS-модуль.';gpsStatusKind='good';
        updateGpsPanel();moveGpsMarker();
      },
      error=>{
        if(error?.code===1)setBadge('GPS: запрет','bad');
        else setBadge('GPS: нет сигнала','warn');
        $('gpsReadout').textContent=error?.code===1?'Разрешите доступ к местоположению в настройках Android.':'GPS недоступен. Выйдите на открытое место и проверьте разрешения.';
      },
      {enableHighAccuracy:true,maximumAge:2000,timeout:25000}
    );
  }catch{setBadge('GPS: ошибка','bad');$('gpsReadout').textContent='Не удалось запустить GPS'}
}
function stopGps(){
  stopPrecision(true);
  if(nativeActive && window.CollectorNative?.stopLocation){
    try{window.CollectorNative.stopLocation()}catch{}
    nativeActive=false;
  }
  if(watch!==null){try{navigator.geolocation.clearWatch(watch)}catch{};watch=null}
}
function retryGps(){
  if(window.CollectorNative?.retryLocation){
    nativeActive=true;
    gpsStatus='Повторно ищем GPS через Android…';gpsStatusKind='warn';updateGpsPanel();
    try{window.CollectorNative.retryLocation();return}catch{
      nativeActive=false;gpsStatus='Не удалось повторить поиск GPS';gpsStatusKind='bad';updateGpsPanel();
      return;
    }
  }
  stopGps();geoWatch();
}
function renderPrecision(){
  if(!precision)return;
  const elapsed=Math.max(0,Math.floor((Date.now()-precision.startedAt)/1000));
  const remaining=Math.max(0,30-elapsed);
  const best=precision.best;
  $('precisionInfo').textContent='Уточнение: '+remaining+' сек. · измерений: '+precision.count+
    (best?' · лучшее спутниковое GPS ±'+Math.round(best.accuracyM)+' м':' · ждём устойчивый спутниковый сигнал');
  $('precisionInfo').hidden=false;
}
function stopPrecision(silent=false){
  if(!precision)return;
  clearInterval(precision.timer);
  precision=null;
  $('precisionBtn').textContent='◎ Уточнить GPS (30 сек.)';
  if(!silent)msg('Уточнение GPS отменено. Существующая выбранная точка не изменилась.');
}
function beginPrecision(){
  if(precision){stopPrecision();return}
  if(document.hidden){msg('Откройте приложение на экране для уточнения GPS.');return}
  if(!nativeActive){geoWatch()}
  precision={startedAt:Date.now(),best:null,count:0,timer:null};
  $('precisionBtn').textContent='× Отменить уточнение';
  $('precisionInfo').hidden=false;
  renderPrecision();
  precision.timer=setInterval(()=>{
    if(!precision)return;
    renderPrecision();
    if(Date.now()-precision.startedAt<30000)return;
    const best=precision.best;
    stopPrecision(true);
    if(!best){
      $('precisionInfo').textContent='Нет подходящих спутниковых точек за 30 сек. Перейдите на открытое место и повторите.';
      msg('Не удалось улучшить точность. Выбери точку вручную на карте или повтори позже.');
      return;
    }
    const point={lat:best.lat,lng:best.lng,accuracyM:best.accuracyM,source:'gps',at:Date.now()};
    choose(point);
    $('precisionInfo').textContent='Выбрано лучшее спутниковое измерение: ±'+Math.round(best.accuracyM)+' м. Проверьте метку на карте — систематическая ошибка GPS всё ещё возможна.';
    msg('Уточнённая GPS-точка выбрана. Проверьте дом на карте перед сохранением.');
  },1000);
}
function choose(point,fly=true){
  chosen=point;lowAccuracyArmed=false;clearSaveFeedback();
  $('selectedLocation').textContent='Выбранная точка: '+gpsText(point)+' · '+(point.source==='gps'?'GPS ±'+Math.round(point.accuracyM)+' м':'вручную на карте');
  $('mapSaveRow').hidden=point.source!=='map';
  if(point.source==='map'){
    $('mapSaveInstruction').textContent='Точка выбрана вручную: '+gpsText(point)+'. Убедитесь, что улица и дом заполнены, затем сохраните прямо здесь.';
  }
  drawChosen();
  if(fly&&map)map.flyTo({center:[point.lng,point.lat],zoom:18,essential:true});
}
function useGps(){
  if(!gps){msg('GPS ещё не определился. Запускаю повторный поиск через Android.');retryGps();return}
  if(Date.now()-gps.at>30000){msg('GPS устарел. Повторно ищем свежие координаты.');retryGps();return}
  if(gps.speed!==null&&gps.speed>1.5){msg('Телефон движется. Остановитесь и дождитесь устойчивого GPS.');return}
  choose({lat:gps.lat,lng:gps.lng,accuracyM:gps.accuracyM,source:'gps',at:Date.now()});
  msg('GPS-точка выбрана. Проверьте положение дома на карте и нажмите «Сохранить адрес».');
}
function pointElement(css){
  const node=document.createElement('div');node.style.cssText=css;return node;
}
function moveGpsMarker(){
  if(!map||!gps)return;
  const coordinate=[gps.lng,gps.lat];
  if(!gpsMarker){
    const e=pointElement('width:18px;height:18px;border:3px solid #fff;border-radius:50%;background:#2997ff;box-shadow:0 0 0 7px #2b9dff55');
    gpsMarker=new maplibregl.Marker({element:e,anchor:'center'}).setLngLat(coordinate).addTo(map);
  }else gpsMarker.setLngLat(coordinate);
}
function drawChosen(){
  if(!map)return;
  if(!chosen){chosenMarker?.remove();chosenMarker=null;return}
  const coord=[chosen.lng,chosen.lat];
  if(!chosenMarker){
    const e=pointElement('width:25px;height:25px;background:#ffd331;border:3px solid #292007;transform:rotate(-45deg);border-radius:50% 50% 50% 0;box-shadow:0 0 0 3px #fff');
    chosenMarker=new maplibregl.Marker({element:e,anchor:'bottom'}).setLngLat(coord).addTo(map);
  }else chosenMarker.setLngLat(coord);
}
function combinedRows(){
  const visible=rows.filter(rec=>!window.SvoiTeamSync?.isLocalHidden?.(rec.id));
  const all=visible.slice(),keys=new Set(visible.map(core.key));
  for(const remote of window.SvoiTeamSync?.getSharedRows?.()||[]){
    const k=core.key(remote);
    if(keys.has(k))continue;
    all.push(remote);keys.add(k);
  }
  return all;
}
function savedGeo(){
  const source=core.toGeoJson(combinedRows());
  for(const f of source.features){
    f.properties.label=f.properties.house;
  }
  return source;
}
function renderHouseNumbers(){
  if(!mapLoaded||!map)return;
  const active=new Set();
  const zoom=map.getZoom();
  if(zoom>=15){
    const bounds=map.getBounds();
    for(const rec of combinedRows()){
      if(active.size>=MAX_NUMBER_MARKERS)break;
      if(!core.validPair(rec.lat,rec.lng)||!bounds.contains([rec.lng,rec.lat]))continue;
      active.add(rec.id);
      const position=[rec.lng,rec.lat],label=rec.house;
      let entry=numberMarkers.get(rec.id);
      if(!entry){
        const element=document.createElement('div');
        element.className='collector-house-number';
        element.style.pointerEvents='none';
        element.textContent=label;
        element.title=rec.street+', '+rec.house+(rec.pointType==='дом'?'':' · '+rec.pointType);
        const marker=new maplibregl.Marker({element,anchor:'center'}).setLngLat(position).addTo(map);
        entry={marker,element};numberMarkers.set(rec.id,entry);
      }else{
        entry.marker.setLngLat(position);
        if(entry.element.textContent!==label)entry.element.textContent=label;
      }
    }
  }
  for(const [id,entry] of numberMarkers){
    if(active.has(id))continue;
    entry.marker.remove();numberMarkers.delete(id);
  }
}
function refreshMapPoints(){
  if(!mapLoaded||!map)return;
  const source=map.getSource('svoi-house-collection');
  if(source)source.setData(savedGeo());
  renderHouseNumbers();
}
function setMapMessage(text){
  $('mapStatus').textContent=text;
}
function setupMap(){
  if(!window.maplibregl){setMapMessage('Модуль карты недоступен. GPS и адреса сохраняются без карты.');return}
  try{
    map=new maplibregl.Map({
      container:'map',style:'https://tiles.versatiles.org/assets/styles/colorful/style.json',
      center:CENTER,zoom:15.5,attributionControl:true,dragRotate:false,touchPitch:false,
      cooperativeGestures:false
    });
    map.addControl(new maplibregl.NavigationControl({showCompass:false}),'top-right');
    map.on('load',()=>{
      mapLoaded=true;
      map.addSource('svoi-house-collection',{type:'geojson',data:savedGeo()});
      map.addLayer({
        id:'svoi-house-circles',type:'circle',source:'svoi-house-collection',
        paint:{'circle-color':'#25cf86','circle-radius':7,'circle-stroke-width':2.5,'circle-stroke-color':'#092c1d'}
      });
      // HTML markers keep house numbers visible even if the tile style has no glyphs.
      renderHouseNumbers();
      setMapMessage('Зелёные с номерами — сохранённые дома. Для подписей приблизьте карту.');
      moveGpsMarker();drawChosen();
    });
    map.on('moveend',renderHouseNumbers);
    map.on('zoomend',renderHouseNumbers);
    map.on('click',event=>{
      if(!manualMode)return;
      manualMode=false;
      $('pickMap').textContent='📍 Поставить точку вручную';
      $('cancelPick').hidden=true;
      $('mapInstruction').textContent='Точка выбрана вручную. Проверьте адрес перед сохранением.';
      choose({lat:event.lngLat.lat,lng:event.lngLat.lng,accuracyM:null,source:'map',at:Date.now()},false);
      msg('Точка отмечена на карте. Сверьте, что метка стоит у правильного дома.');
    });
    map.on('error',()=>{
      if(Date.now()-lastMapError>12000){
        lastMapError=Date.now();
        setMapMessage('Слой карты не загрузился — проверьте интернет. Сбор и сохранение адресов работают без сети.');
      }
    });
  }catch{
    setMapMessage('Карта недоступна, но адреса можно собирать по GPS.');
  }
}
function render(){
  const all=combinedRows();
  const noun=all.length===1?'адрес':all.length>=2&&all.length<=4?'адреса':'адресов';
  $('headerCount').textContent=all.length+' '+noun;
  const visibleMine=rows.filter(rec=>!window.SvoiTeamSync?.isLocalHidden?.(rec.id)).length;
  $('listCount').textContent=all.length+' всего · моих '+visibleMine+(rows.length>visibleMine?' · скрыто диспетчером '+(rows.length-visibleMine):'');
  const q=$('filter').value.trim().toLocaleLowerCase('ru');
  const list=$('addressList');list.replaceChildren();
  const found=all.filter(r=>[r.settlement,r.street,r.house,r.entrance].join(' ').toLocaleLowerCase('ru').includes(q)).slice().reverse();
  if(!found.length){
    const empty=document.createElement('div');empty.className='empty';
    empty.textContent=all.length?'Нет совпадений.':'Точек пока нет. Остановитесь у дома, выберите GPS и сохраните первый адрес.';
    list.appendChild(empty);
    return;
  }
  for(const rec of found.slice(0,150)){
    const item=document.createElement('div');item.className='addr-item';
    const body=document.createElement('div');
    const title=document.createElement('div');title.className='addr-title';
    title.textContent=rec.street+', '+rec.house+' · '+rec.settlement;
    const meta=document.createElement('div');meta.className='addr-meta';
    meta.textContent=rec.pointType+(rec.entrance?' · '+rec.entrance:'')+' · '+gpsText(rec)+(rec.accuracyM!==null?' · ±'+Math.round(rec.accuracyM)+' м':' · по карте')+
      (rec.collectorName?' · добавил: '+rec.collectorName:'')+
      (window.SvoiTeamSync?.isConflict?.(rec.id)?' · ⚠ Дубль в общей базе':'');
    body.append(title,meta);
    const actions=document.createElement('div');actions.className='addr-actions';
    if(!rows.some(local=>local.id===rec.id)){
      const readonly=document.createElement('div');
      readonly.className='addr-meta';
      readonly.textContent='Общая точка · удалить из общей базы может диспетчер';
      item.append(body,readonly);list.appendChild(item);continue;
    }
    const edit=document.createElement('button');edit.type='button';edit.textContent='Править';
    edit.addEventListener('click',()=>editRecord(rec.id));
    const del=document.createElement('button');del.type='button';del.className='del';
    const confirming=pendingDeleteId===rec.id&&Date.now()<pendingDeleteUntil;
    del.textContent=confirming?'Да, удалить':'Удалить';
    del.setAttribute('aria-label',(confirming?'Подтвердить удаление ':'Удалить ')+rec.street+', '+rec.house);
    del.addEventListener('click',()=>{
      // Android WebView without a WebChromeClient silently rejects confirm().
      // Require two deliberate taps instead of a JavaScript modal dialog.
      const now=Date.now();
      if(pendingDeleteId!==rec.id||now>pendingDeleteUntil){
        pendingDeleteId=rec.id;pendingDeleteUntil=now+30000;
        render();
        msg('Подтвердите удаление адреса кнопкой «Да, удалить»: '+rec.street+', '+rec.house+'.');
        return;
      }
      pendingDeleteId=null;pendingDeleteUntil=0;
      if(persist(rows.filter(r=>r.id!==rec.id))){
        window.SvoiTeamSync?.onLocalDeleted?.(rec.id);
        // The old shared snapshot can still contain this ID after local deletion.
        render();refreshMapPoints();
        msg('Адрес удалён с телефона. Общая база обновится при синхронизации.');
      }
    });
    actions.append(edit,del);
    if(confirming){
      const cancel=document.createElement('button');
      cancel.type='button';cancel.textContent='Отмена';
      cancel.addEventListener('click',()=>{pendingDeleteId=null;pendingDeleteUntil=0;render()});
      actions.append(cancel);
      const warning=document.createElement('div');
      warning.className='addr-meta';
      warning.textContent='Подтвердите удаление этой точки или нажмите «Отмена».';
      item.append(body,actions,warning);
    }else item.append(body,actions);
    list.appendChild(item);
  }
}
function clearForm(){
  editId=null;$('street').value='';$('house').value='';$('entrance').value='';$('pointType').value='дом';$('comment').value='';
  $('editBadge').textContent='Новая точка';
  chosen=null;lowAccuracyArmed=false;$('mapSaveRow').hidden=true;clearSaveFeedback();
  $('selectedLocation').textContent='Точка адреса ещё не выбрана.';drawChosen();
  $('street').focus();
}
function editRecord(id){
  const rec=rows.find(r=>r.id===id);if(!rec)return;
  editId=id;
  for(const key of ['settlement','street','house','entrance','pointType','comment'])$(key).value=rec[key]||'';
  $('editBadge').textContent='Редактирование';
  choose({lat:rec.lat,lng:rec.lng,accuracyM:rec.accuracyM,source:rec.source,at:Date.now(),saved:true});
  window.scrollTo({top:0,behavior:'smooth'});
  msg('Редактируете сохранённый адрес. Не забудьте сохранить изменения.');
}
function saveAddress(){
  clearSaveFeedback();
  if(storageBlocked)return showSaveFeedback('Локальная база повреждена. Сначала выгрузите данные: новые адреса не записываются.');
  for(const [field,label] of [['settlement','населённый пункт'],['street','улицу'],['house','номер дома']]){
    if(!$(field).value.trim())return showSaveFeedback('Заполните '+label+' перед сохранением.', 'bad',field);
  }
  if(!chosen)return showSaveFeedback('Сначала выберите точку: кнопка «Взять GPS» или «Поставить точку вручную» на карте.');
  if(!core.validPair(chosen.lat,chosen.lng))
    return showSaveFeedback('Выбранные координаты некорректны. Поставьте точку заново.');
  if(chosen.source==='gps'&&!chosen.saved){
    if(Date.now()-chosen.at>60000){
      lowAccuracyArmed=false;
      return showSaveFeedback('GPS-точка устарела. Возьмите её снова или поставьте точку вручную.', 'bad');
    }
    if(Number.isFinite(chosen.accuracyM)&&chosen.accuracyM>30&&!lowAccuracyArmed){
      lowAccuracyArmed=true;
      return showSaveFeedback('GPS ±'+Math.round(chosen.accuracyM)+' м. Если точка действительно верная, нажмите «Сохранить адрес» ещё раз.', 'warn');
    }
  }
  // Manually selected coordinates are deliberate: never block them behind a
  // browser confirm() dialogue (Android WebView may silently reject confirm).
  const previous=rows.find(r=>r.id===editId);
  const next=core.normalizeRecord({
    id:previous?.id||('addr-'+Date.now()+'-'+Math.random().toString(36).slice(2,10)),
    settlement:$('settlement').value,street:$('street').value,house:$('house').value,
    entrance:$('entrance').value,pointType:$('pointType').value,comment:$('comment').value,
    lat:chosen.lat,lng:chosen.lng,accuracyM:chosen.accuracyM,source:chosen.source,
    capturedAt:previous?.capturedAt||new Date().toISOString()
  });
  if(!next)return showSaveFeedback('Не удалось проверить адрес и координаты. Проверьте данные.');
  const dup=core.findDuplicate(combinedRows().filter(r=>r.id!==next.id),next);
  if(dup){
    lowAccuracyArmed=false;
    return showSaveFeedback('Такой дом и тип точки уже есть на общей карте. Повторно сохранять не нужно.');
  }
  const updated=editId?rows.map(r=>r.id===editId?next:r):rows.concat(next);
  if(!persist(updated))return showSaveFeedback('Не удалось сохранить точку на телефоне. Проверьте свободную память и резервную копию.');
  const count=updated.length;
  clearForm(); // Draft yellow marker removed; new saved house remains green.
  const success=previous?'Адрес обновлён.':'Адрес сохранён на телефоне. Всего моих: '+count+'.';
  showSaveFeedback(success+' Общая карта обновится после синхронизации.', 'success');
  msg(success+(count%25===0?' Сделайте резервную копию GeoJSON!':''));
  if(count%25===0)alert('Сохранено '+count+' адресов. Рекомендуем выгрузить резервную копию GeoJSON.');
}
function exportFile(type){
  if(!rows.length){msg('Сначала сохраните хотя бы один адрес.');return}
  if(!window.CollectorNative){msg('Выгрузка доступна в установленном Android-приложении.');return}
  if(type==='geo')window.CollectorNative.exportGeoJson(JSON.stringify(core.toGeoJson(rows),null,2));
  else window.CollectorNative.exportCsv(core.toCsv(rows));
}
function receiveImport(content){
  if(storageBlocked){msg('Импорт заблокирован: текущая локальная база повреждена.');return}
  try{
    const incoming=core.parseGeoJson(content),merged=core.mergeRecords(rows,incoming);
    if(!merged.added){msg('Новых адресов нет. Пропущено: '+merged.skipped+'.');return}
    if(!confirm('Добавить '+merged.added+' точек из GeoJSON? Дубликатов пропущено: '+merged.skipped+'.'))return;
    if(persist(merged.rows))msg('Импортировано: '+merged.added+'. Пропущено: '+merged.skipped+'.');
  }catch(error){msg('Ошибка импорта: '+String(error?.message||'неизвестный формат'))}
}
$('useGps').addEventListener('click',useGps);
$('precisionBtn').addEventListener('click',beginPrecision);
$('retryGps').addEventListener('click',retryGps);
$('gpsSettings').addEventListener('click',()=>{
  if(window.CollectorNative?.openGpsSettings)window.CollectorNative.openGpsSettings();
  else msg('Откройте настройки местоположения Android.');
});
$('viewMe').addEventListener('click',()=>{
  if(!gps){msg('GPS ещё не определился');return}
  if(map)map.flyTo({center:[gps.lng,gps.lat],zoom:17.6,essential:true});
});
$('pickMap').addEventListener('click',()=>{
  if(!map||!mapLoaded){msg('Карта ещё не загрузилась. Можно сохранить координаты по GPS.');return}
  manualMode=true;
  $('pickMap').textContent='Коснитесь дома на карте';
  $('cancelPick').hidden=false;
  $('mapInstruction').textContent='Коснитесь нужного здания. Жёлтая метка будет показана на выбранном месте.';
  msg('Режим выбора точки включён. Коснитесь нужного дома на карте.');
});
$('cancelPick').addEventListener('click',()=>{
  manualMode=false;$('pickMap').textContent='📍 Поставить точку вручную';$('cancelPick').hidden=true;
  $('mapInstruction').textContent='Для точного расположения дома можно выбрать метку вручную на карте.';
});
$('resetForm').addEventListener('click',clearForm);
$('savePoint').addEventListener('click',saveAddress);
$('saveFromMap').addEventListener('click',saveAddress);
for(const field of ['settlement','street','house'])$(field).addEventListener('input',()=>{
  $(field).removeAttribute('aria-invalid');clearSaveFeedback();lowAccuracyArmed=false;
});
$('filter').addEventListener('input',render);
$('exportGeo').addEventListener('click',()=>exportFile('geo'));
$('exportCsv').addEventListener('click',()=>exportFile('csv'));
$('checkForUpdates').addEventListener('click',()=>{
  if(window.CollectorNative?.checkForUpdates)window.CollectorNative.checkForUpdates();
  else onUpdateStatus({state:'error',message:'Проверка обновлений доступна в Android-приложении версии 0.8.1 и выше.'});
});
$('installUpdate').addEventListener('click',()=>{
  if(window.CollectorNative?.installAvailableUpdate)window.CollectorNative.installAvailableUpdate();
});
$('updateDialogInstall').addEventListener('click',()=>{
  if(window.CollectorNative?.installAvailableUpdate)window.CollectorNative.installAvailableUpdate();
});
$('updateDialogLater').addEventListener('click',()=>{
  updateDismissedVersion=updatePromptVersion;
  $('updateDialog').hidden=true;
  $('checkForUpdates').focus();
});
$('importGeo').addEventListener('click',()=>{
  if(!window.CollectorNative){msg('Импорт доступен в Android-приложении.');return}
  window.CollectorNative.importGeoJson();
});
document.addEventListener('visibilitychange',()=>{
  if(document.hidden)stopGps();
  else {
    geoWatch();map?.resize();
    // Refresh availability on app return after a long pause; never auto-install.
    if(Date.now()-lastUpdateCheckAt>30*60*1000&&window.CollectorNative?.checkForUpdates){
      lastUpdateCheckAt=Date.now();
      window.CollectorNative.checkForUpdates();
    }
  }
});
window.SvoiCollector=Object.freeze({receiveImport,onNativeLocation,onNativeStatus,onUpdateStatus,localRows:()=>rows,localStorageHealthy:()=>!storageBlocked,refreshShared:()=>{render();refreshMapPoints()},notify:msg});
rows=safeLoad();render();updateGpsPanel();geoWatch();setupMap();
// Checking in the background is read-only; download and installation require a tap.
setTimeout(()=>{if(window.CollectorNative?.checkForUpdates){
  lastUpdateCheckAt=Date.now();window.CollectorNative.checkForUpdates();
}},1600);
setInterval(()=>{if(!document.hidden)updateGpsPanel()},10000);
})();