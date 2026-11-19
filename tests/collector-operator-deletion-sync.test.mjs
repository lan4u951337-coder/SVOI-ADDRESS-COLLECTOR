import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const JS=readFileSync(new URL('../android-driver/address-collector/src/main/assets/team-sync.js',import.meta.url),'utf8');
const CREDENTIALS='svoi.addressCollector.team.credentials.v1';
const SYNC='svoi.addressCollector.team.uploaded.v1:Сергей';
const HIDDEN='svoi.addressCollector.team.operatorHidden.v1:Сергей';
const sample={
  id:'addr-2026-1119-123',settlement:'Агинское',street:'Ленина',
  house:'5',pointType:'дом',entrance:'',comment:'',lat:55.2586,lng:94.9079,
  accuracyM:null,source:'map',capturedAt:'2026-11-17T09:00:00.000Z'
};

function create({existing=[sample],synced=true,total=0,addresses=[],postDeleted=false,storage=null}={}){
  const store=storage||new Map();
  if(!store.has(CREDENTIALS))store.set(CREDENTIALS,JSON.stringify({name:'Сергей',secret:'x'.repeat(32)}));
  if(!store.has(SYNC)&&synced)store.set(SYNC,JSON.stringify({[sample.id]:'previously-uploaded-digest'}));
  const requests=[],events=new Map(),nodes=new Map(),uiUpdates=[];
  const element=id=>{
    if(!nodes.has(id))nodes.set(id,{
      id,value:'',textContent:'',className:'',disabled:false,handlers:new Map(),
      addEventListener(event,handler){this.handlers.set(event,handler)},
      replaceChildren(){},appendChild(){},append(){},
    });
    return nodes.get(id);
  };
  const window={
    addEventListener(){},
    SvoiCollector:{
      localRows:()=>existing,
      localStorageHealthy:()=>true,
      refreshShared:()=>uiUpdates.push('map-refreshed')
    },
  };
  const context=vm.createContext({
    console,Date,Map,Set,JSON,Math,Number,Array,String,
    window,document:{hidden:false,getElementById:element,createElement:()=>element('new-node'),addEventListener(){}},
    localStorage:{
      getItem:key=>store.get(key)??null,
      setItem:(key,value)=>{store.set(key,value)},
      removeItem:key=>store.delete(key)
    },
    navigator:{onLine:true},AbortController,
    fetch:async (_url,opts)=>{
      const method=opts.method||'GET';
      requests.push({method,body:opts.body?JSON.parse(opts.body):null});
      const response=method==='GET'?
        {ok:true,addresses,stats:[],total}:method==='POST'?
        {ok:true,deleted:postDeleted}: {ok:true};
      return {ok:true,status:200,json:async()=>response};
    },
    setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},
  });
  vm.runInContext(JS,context,{timeout:2000});
  return {context,store,requests,events,nodes,element,window,uiUpdates,existing,
    async sync(){
      element('syncNow').handlers.get('click')();
      for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));
    }
  };
}

test('complete server snapshot hides operator-deleted synchronized local point on all map refreshes',async()=>{
  const app=create();
  assert.equal(app.window.SvoiTeamSync.isLocalHidden(sample.id),false);
  await app.sync();
  assert.equal(app.window.SvoiTeamSync.isLocalHidden(sample.id),true);
  assert.equal(app.requests.filter(x=>x.method==='POST').length,0,
    'do not resurrect deleted point via stale phone POST');
  assert.deepEqual(JSON.parse(app.store.get(HIDDEN)),[sample.id]);
  assert.equal(app.existing.length,1,'local record stays backed up');
  assert.ok(app.uiUpdates.length>=1);
  assert.match(app.element('syncPending').textContent,/скрыто диспетчером: 1/);
  const reopened=create({storage:app.store});
  assert.equal(reopened.window.SvoiTeamSync.isLocalHidden(sample.id),true,
    'operator deletion must persist across app restart');
});

test('never hide a local point based on truncated or incomplete server snapshot',async()=>{
  const app=create({total:10001,addresses:[]});
  await app.sync();
  assert.equal(app.window.SvoiTeamSync.isLocalHidden(sample.id),false);
  assert.equal(app.store.has(HIDDEN),false);
});

test('unsent offline local point stays visible and uploads when server is empty',async()=>{
  const app=create({synced:false});
  await app.sync();
  assert.equal(app.window.SvoiTeamSync.isLocalHidden(sample.id),false);
  assert.equal(app.requests.filter(x=>x.method==='POST').length,1);
});

test('server tombstone response hides a stale local record instead of claiming upload success',async()=>{
  const app=create({synced:false,postDeleted:true});
  await app.sync();
  assert.equal(app.requests.filter(x=>x.method==='POST').length,1);
  assert.equal(app.window.SvoiTeamSync.isLocalHidden(sample.id),true);
  assert.deepEqual(JSON.parse(app.store.get(HIDDEN)),[sample.id]);
});
