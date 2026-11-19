import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const BASE='android-driver/address-collector/src/main/assets/';
const js=read(BASE+'collector.js');
const html=read(BASE+'collector.html');
const css=read(BASE+'collector.css');

function testApp(){
  const nodes=new Map(),storage=new Map(),mapEvents=new Map(),allMarkers=[];
  let alerts=0,confirms=0;
  const element=(id='')=>{
    const e={
      id,style:{},className:'',textContent:'',value:'',hidden:false,children:[],
      handlers:new Map(),attributes:new Map(),classList:{add(){},remove(){}},
      addEventListener(type,fn){this.handlers.set(type,fn)},
      setAttribute(k,v){this.attributes.set(k,v)},
      removeAttribute(k){this.attributes.delete(k)},
      getAttribute(k){return this.attributes.get(k)},
      replaceChildren(...children){this.children=children},
      append(...children){this.children.push(...children)},
      appendChild(child){this.children.push(child);return child},
      focus(){},
      scrollIntoView(){},
    };
    return e;
  };
  const $=id=>{if(!nodes.has(id))nodes.set(id,element(id));return nodes.get(id)};
  $('settlement').value='Агинское';
  $('pointType').value='дом';
  $('filter').value='';
  class MapMock {
    constructor(){this.zoom=17.5;this.sources=new Map();this.bounds={contains:([lng,lat])=>lng>90&&lng<99&&lat>50&&lat<59}}
    on(name,fn){mapEvents.set(name,fn)}
    addControl(){}
    addSource(name,source){this.sources.set(name,{data:source.data,setData(v){this.data=v}})}
    getSource(name){return this.sources.get(name)}
    addLayer(){}
    getZoom(){return this.zoom}
    getBounds(){return this.bounds}
    flyTo(){}
    resize(){}
  }
  class MarkerMock{
    constructor(options){this.element=options.element;this.removed=false;allMarkers.push(this)}
    setLngLat(value){this.coordinates=value;return this}
    addTo(){return this}
    remove(){this.removed=true}
  }
  const native={startLocation(){},stopLocation(){}};
  const maplibre={Map:MapMock,Marker:MarkerMock,NavigationControl:class {}};
  const context=vm.createContext({
    console,Date,Math,Map,Set,Number,JSON,
    document:{hidden:false,getElementById:$,createElement:()=>element(),addEventListener(){}},
    navigator:{onLine:true},window:{CollectorNative:native,maplibregl:maplibre,scrollTo(){},addEventListener(){}},
    localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,v)=>storage.set(key,v),removeItem:key=>storage.delete(key)},
    maplibregl:maplibre,
    setInterval(){return 1},clearInterval(){},setTimeout(){return 1},clearTimeout(){},
    alert(){alerts++},confirm(){confirms++;throw Error('Android WebView confirm must not be required for manual save')},
  });
  vm.runInContext(read(BASE+'address-core.js'),context,{timeout:1000});
  context.window.SvoiGpsQuality={};
  vm.runInContext(js,context,{timeout:2000});
  mapEvents.get('load')();
  return {nodes,$,storage,mapEvents,allMarkers,context,alerts:()=>alerts,confirms:()=>confirms};
}
function click(element){const cb=element.handlers.get('click');assert.equal(typeof cb,'function');cb()}
function placeManual(app,lat=55.2586,lng=94.9079){
  click(app.$('pickMap'));
  app.mapEvents.get('click')({lngLat:{lat,lng}});
}

test('manual map point saves with no GPS and no JavaScript confirm dialog',()=>{
  const app=testApp();
  placeManual(app);
  assert.equal(app.$('mapSaveRow').hidden,false);
  assert.match(app.$('selectedLocation').textContent,/вручную на карте/);
  click(app.$('saveFromMap'));
  assert.equal(app.storage.get('svoi.addressCollector.records.v1'),undefined);
  assert.match(app.$('saveFeedback').textContent,/улицу/);
  assert.match(app.$('mapSaveFeedback').textContent,/улицу/);
  assert.equal(app.$('street').getAttribute('aria-invalid'),'true');

  app.$('street').value='Ленина';
  app.$('house').value='15А';
  app.$('street').handlers.get('input')();
  click(app.$('saveFromMap'));
  const rows=JSON.parse(app.storage.get('svoi.addressCollector.records.v1'));
  assert.equal(rows.length,1);
  assert.equal(rows[0].street,'Ленина');
  assert.equal(rows[0].house,'15А');
  assert.equal(rows[0].source,'map');
  assert.equal(rows[0].accuracyM,null);
  assert.equal(app.confirms(),0);
  assert.match(app.$('saveFeedback').textContent,/Адрес сохранён/);
  assert.equal(app.$('mapSaveRow').hidden,true);
  const house=app.allMarkers.find(x=>x.element.className==='collector-house-number'&&!x.removed);
  assert.ok(house,'numbered green marker must exist');
  assert.equal(house.element.textContent,'15А');
});

test('map numbers render for shared addresses and update on viewport changes',()=>{
  const app=testApp();
  const point={id:'addr-remote-1',street:'Титова',house:'72',settlement:'Агинское',
    pointType:'дом',entrance:'',comment:'',lat:55.2587,lng:94.908,accuracyM:null,
    source:'map',capturedAt:'2026-11-17T00:00:00Z',collectorName:'Сергей'};
  app.context.window.SvoiTeamSync={getSharedRows:()=>[point]};
  app.context.window.SvoiCollector.refreshShared();
  const labeled=app.allMarkers.find(x=>x.element.className==='collector-house-number'&&!x.removed);
  assert.ok(labeled);
  assert.equal(labeled.element.textContent,'72');
  app.mapEvents.get('moveend')();
  assert.equal(app.allMarkers.filter(x=>x.element.className==='collector-house-number'&&!x.removed).length,1);
});

test('duplicate manually selected address reports error beside save and retains draft',()=>{
  const app=testApp();
  app.$('street').value='Ленина';app.$('house').value='15А';
  placeManual(app);
  click(app.$('saveFromMap'));
  placeManual(app,55.25865,94.908);
  app.$('street').value='ленина';app.$('house').value='15а';
  click(app.$('saveFromMap'));
  assert.match(app.$('saveFeedback').textContent,/уже есть/);
  assert.match(app.$('mapSaveFeedback').textContent,/уже есть/);
  assert.equal(JSON.parse(app.storage.get('svoi.addressCollector.records.v1')).length,1);
  assert.equal(app.$('mapSaveRow').hidden,false);
});

test('collector no longer relies on remote font glyphs for visible house numbers',()=>{
  assert.match(js,/function renderHouseNumbers\(\)/);
  assert.match(js,/className='collector-house-number'/);
  assert.match(js,/element\.textContent=label/);
  assert.match(js,/MAX_NUMBER_MARKERS=220/);
  assert.match(js,/map\.on\('moveend',renderHouseNumbers\)/);
  assert.doesNotMatch(js,/id:'svoi-house-labels',type:'symbol'/);
  assert.match(css,/\.collector-house-number/);
  assert.match(html,/id="saveFeedback"/);
  assert.match(html,/id="mapSaveFeedback"/);
  assert.match(html,/id="saveFromMap"/);
  assert.doesNotMatch(js,/confirm\('Точка поставлена/);
});

const syncJs=read(BASE+'team-sync.js');
function deleteButton(app){
  const item=app.$('addressList').children[0];
  assert.ok(item,'expected an address row');
  const actions=item.children[1];
  return actions?.children?.find(el=>el.textContent==='Удалить'||el.textContent==='Да, удалить');
}
test('delete is confirmed by two taps, never by blocked Android WebView confirm()',()=>{
  const app=testApp();
  app.$('street').value='Ленина';app.$('house').value='15А';
  placeManual(app);click(app.$('saveFromMap'));
  assert.equal(JSON.parse(app.storage.get('svoi.addressCollector.records.v1')).length,1);
  click(deleteButton(app));
  assert.equal(JSON.parse(app.storage.get('svoi.addressCollector.records.v1')).length,1);
  assert.equal(deleteButton(app).textContent,'Да, удалить');
  click(deleteButton(app));
  assert.equal(JSON.parse(app.storage.get('svoi.addressCollector.records.v1')).length,0);
  assert.equal(app.$('listCount').textContent,'0 всего · моих 0');
  assert.equal(app.confirms(),0,'Android WebView confirm() must never be called for delete');
  assert.equal(app.allMarkers.filter(m=>m.element.className==='collector-house-number'&&!m.removed).length,0);
});
test('removing an owned point does not resurrect an old shared copy',()=>{
  const app=testApp();
  app.$('street').value='Ленина';app.$('house').value='15А';
  placeManual(app);click(app.$('saveFromMap'));
  let shared=JSON.parse(app.storage.get('svoi.addressCollector.records.v1'));
  let queuedDelete=null;
  app.context.window.SvoiTeamSync={
    getSharedRows:()=>shared,
    onLocalDeleted:id=>{queuedDelete=id;shared=shared.filter(r=>r.id!==id)},
  };
  click(deleteButton(app));click(deleteButton(app));
  assert.ok(queuedDelete);
  assert.equal(app.$('headerCount').textContent,'0 адресов');
  assert.equal(app.$('addressList').children.length,1);
  assert.match(app.$('addressList').children[0].textContent,/Точек пока нет/);
  assert.match(syncJs,/function onLocalDeleted\(id\)\{[\s\S]*?shared=shared\.filter\(record=>record\.id!==id\)/);
  assert.match(syncJs,/function getSharedRows\(\)\{return shared\.filter\(record=>!deletedIds\.includes\(record\.id\)\)\}/);
});

test('a dispatcher-deleted local point vanishes from map without erasing its phone backup',()=>{
  const app=testApp();
  app.$('street').value='Титова';app.$('house').value='72';
  placeManual(app);click(app.$('saveFromMap'));
  const local=JSON.parse(app.storage.get('svoi.addressCollector.records.v1'));
  assert.equal(local.length,1);
  app.context.window.SvoiTeamSync={
    getSharedRows:()=>[],
    isLocalHidden:id=>id===local[0].id,
  };
  app.context.window.SvoiCollector.refreshShared();
  assert.equal(app.$('headerCount').textContent,'0 адресов');
  assert.match(app.$('listCount').textContent,/скрыто диспетчером 1/);
  assert.equal(app.allMarkers.filter(x=>x.element.className==='collector-house-number'&&!x.removed).length,0);
  assert.equal(JSON.parse(app.storage.get('svoi.addressCollector.records.v1')).length,1,
    'original phone backup must remain intact');
});
test('remote point is explicitly read-only to collectors',()=>{
  const app=testApp();
  app.context.window.SvoiTeamSync={getSharedRows:()=>[{
    id:'remote-record',settlement:'Агинское',street:'Титова',house:'71',
    pointType:'дом',entrance:'',comment:'',lat:55.2586,lng:94.9079,
    accuracyM:null,source:'map',capturedAt:'2026-11-19T00:00:00.000Z'
  }]};
  app.context.window.SvoiCollector.refreshShared();
  const item=app.$('addressList').children[0];
  assert.equal(item.children[1].textContent,'Общая точка · удалить из общей базы может диспетчер');
});
