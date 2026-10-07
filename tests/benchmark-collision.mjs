// Pure physics benchmark; no desktop operations, icon names, or private data.
// These times exclude painting, IPC and Windows composition; they are not FPS.
import ts from 'typescript';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
const api={};
Function('exports',ts.transpileModule(readFileSync('src/collision-model.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText)(api);
const size=55,icons=Array.from({length:128},(_,i)=>{const x=20+Math.floor(i/8)*95,y=2+i%8*122;return{id:String(i),name:'',image:'',x,y,home:{x,y}}});
const scene={token:1,grid:{x:95,y:122},iconSize:size,origin:{x:0,y:0},areas:[{x:0,y:0,w:1920,h:1020}],boards:[{x:20,y:2,w:600,h:700,radius:15}],icons};
const shape=api.squareShape(size),world=new api.CollisionWorld(scene,new Map(icons.map(i=>[i.id,shape]))),times=[];
for(let i=0;i<120;i++){
 world.update({...scene,boards:[{x:20+Math.sin(i/14)*150,y:2+Math.sin(i/21)*160,w:600,h:700,radius:15}]});
 const began=performance.now();world.step(1/60);if(i>=30)times.push(performance.now()-began);
}
times.sort((a,b)=>a-b);
console.log(JSON.stringify({physicsOnly:true,icons:128,active:[...world.bodies.values()].filter(b=>b.active).length,meanMs:times.reduce((a,b)=>a+b)/times.length,p50Ms:times[Math.floor(times.length*.5)],p95Ms:times[Math.floor(times.length*.95)],maxMs:times.at(-1)},null,2));
