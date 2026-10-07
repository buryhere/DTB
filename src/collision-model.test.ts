import { expect, it } from 'vitest';
import { CollisionWorld, shapeFromAlpha, squareShape, worldSamples, boardDistance } from './collision-model';
import type { DesktopScene, Shape } from './collision-model';
const scene = (): DesktopScene => ({token:1,grid:{x:60,y:70},iconSize:24,origin:{x:0,y:0},areas:[{x:0,y:0,w:600,h:400}],boards:[],icons:[{id:'a',name:'name excluded from body',image:'',x:180,y:150,home:{x:180,y:150}},{id:'b',name:'untouched',image:'',x:350,y:150,home:{x:350,y:150}}]});
const run = (world:CollisionWorld, seconds:number) => {for(let i=0;i<seconds*120;i++)world.step(1/120)};
const make=(s=scene(),shape:Shape=squareShape(24))=>new CollisionWorld(s,new Map(s.icons.map(i=>[i.id,shape])));
it('ignores transparent pixels including internal holes',()=>{
 const data=new Uint8Array(16*16*4);for(let y=0;y<16;y++)for(let x=0;x<16;x++)if(x<3||x>12||y<3||y>12)data[(y*16+x)*4+3]=255;
 const shape=shapeFromAlpha(data,16,16,16);
 expect(shape.samples.some(p=>Math.abs(p.x)<3&&Math.abs(p.y)<3)).toBe(false);
 expect(shape.samples.length).toBeGreaterThan(20);
});
it('pair contacts preserve a transparent hole instead of using a solid hull',()=>{
 const s=scene(),ring=new Uint8Array(24*24*4),small=new Uint8Array(24*24*4);
 for(let y=0;y<24;y++)for(let x=0;x<24;x++){if(x<4||x>=20||y<4||y>=20)ring[(y*24+x)*4+3]=255;if(x>=9&&x<15&&y>=9&&y<15)small[(y*24+x)*4+3]=255;}
 s.icons=[s.icons[0],{...s.icons[1],x:181,y:150,home:{x:180,y:150}}];
 const w=new CollisionWorld(s,new Map([['a',shapeFromAlpha(ring,24,24,24)],['b',shapeFromAlpha(small,24,24,24)]]));
 run(w,3);expect(w.allHome).toBe(true);expect(w.bodies.get('a')!.active).toBe(false);expect(w.targets.b).toEqual({x:180,y:150});
});
it('a static blocked group sleeps and wakes immediately when the board moves away',()=>{
 const w=make();w.update({...w.scene,boards:[{x:170,y:120,w:55,h:100,radius:10}]});run(w,4);
 expect(w.sleeping).toBe(true);const targets=w.targets;run(w,1);expect(w.targets).toEqual(targets);
 w.update({...w.scene,boards:[]});expect(w.sleeping).toBe(false);run(w,6);expect(w.allHome).toBe(true);
});
it('preserves all unaffected positions and names state',()=>{const w=make();run(w,1);expect(w.allHome).toBe(true);expect(w.targets).toEqual({a:{x:180,y:150},b:{x:350,y:150}})});
it('pushes continuously with the board contour and hides participating names',()=>{
 const w=make();w.update({...w.scene,boards:[{x:170,y:120,w:55,h:100,radius:10}]});run(w,2);
 const b=w.bodies.get('a')!;expect(b.active).toBe(true);expect(Math.hypot(b.x-180,b.y-150)).toBeGreaterThan(15);
 expect(worldSamples(b,24).every(p=>boardDistance(p,w.scene.boards[0]).d>=p.radius-.8)).toBe(true);
 expect(w.bodies.get('b')!.active).toBe(false);
});
it('a glancing moving contact creates rotation, then springs back with overshoot',()=>{
 const s=scene();s.boards=[{x:70,y:115,w:70,h:45,radius:8}];const w=make(s);let maxRotation=0;
 for(let i=0;i<30;i++){w.update({...w.scene,boards:[{x:70+i*4,y:115,w:70,h:45,radius:8}]});w.step(1/60);maxRotation=Math.max(maxRotation,Math.abs(w.bodies.get('a')!.angle))}
 expect(maxRotation).toBeGreaterThan(.01);
 const start=w.bodies.get('a')!.x-180;w.update({...w.scene,boards:[]});let overshoot=false;
 for(let i=0;i<720;i++){w.step(1/120);if((w.bodies.get('a')!.x-180)*start<-.05)overshoot=true}
 expect(overshoot).toBe(true);expect(w.allHome).toBe(true);expect(w.targets.a).toEqual({x:180,y:150});expect(w.bodies.get('a')!.angle).toBe(0);
});
it('fast board movement cannot tunnel through an icon',()=>{
 const s=scene();s.boards=[{x:30,y:130,w:30,h:60}];const w=make(s);w.update({...s,boards:[{x:280,y:130,w:30,h:60}]});w.step(1/30);
 expect(w.bodies.get('a')!.active).toBe(true);expect(w.bodies.get('a')!.x).toBeGreaterThan(210);
});
it('keeps manually pinned icons still and respects negative monitor coordinates',()=>{
 const s=scene();s.areas=[{x:-600,y:-400,w:600,h:400}];s.icons=s.icons.map((i,n)=>({...i,x:-200+n*80,y:-150,home:{x:-200+n*80,y:-150},pinned:n===1}));s.boards=[{x:-220,y:-170,w:160,h:100}];const w=make(s);run(w,1);
 expect(w.targets.b).toEqual({x:-120,y:-150});expect(w.bodies.get('a')!.active).toBe(true);
 w.update({...w.scene,boards:[]});run(w,6);expect(w.targets.a).toEqual({x:-200,y:-150});
});
it('file names and transparent padding do not collide with a board',()=>{
 const s=scene();const data=new Uint8Array(24*24*4);for(let y=8;y<16;y++)for(let x=8;x<16;x++)data[(y*24+x)*4+3]=255;
 s.boards=[{x:176,y:150,w:8,h:90,radius:0}];const w=make(s,shapeFromAlpha(data,24,24,24));run(w,1);expect(w.bodies.get('a')!.active).toBe(false);
});
it('chooses an available side instead of trapping icons between a board and a screen edge',()=>{
 const s=scene();s.icons=[{...s.icons[0],x:2,y:2,home:{x:2,y:2}}];s.boards=[{x:0,y:0,w:90,h:100,radius:10}];
 const w=make(s);run(w,2);const b=w.bodies.get('a')!;
 expect(worldSamples(b,24).every(p=>boardDistance(p,s.boards[0]).d>=p.radius-1)).toBe(true);
 expect(worldSamples(b,24).every(p=>p.x-p.radius>=-.1&&p.y-p.radius>=-.1)).toBe(true);
});
it('icons pushed past each other return around the neighbor instead of jamming face to face',()=>{
 const s=scene();s.icons=[{...s.icons[0],x:180,y:200,home:{x:180,y:120}},{...s.icons[1],x:180,y:140,home:{x:180,y:220}}];
 const w=make(s);run(w,8);expect(w.allHome).toBe(true);expect(w.targets).toEqual({a:{x:180,y:120},b:{x:180,y:220}});
});
it('deeply overlapping exchanged icons separate consistently instead of oscillating forever',()=>{
 const s=scene();s.iconSize=55;s.areas=[{x:0,y:0,w:900,h:1000}];
 s.icons=[{...s.icons[0],x:401.915,y:553.028,home:{x:400,y:490}},{...s.icons[1],x:398.085,y:548.972,home:{x:400,y:612}}];
 const w=make(s,squareShape(55));run(w,12);
 expect(w.allHome).toBe(true);expect(w.targets).toEqual({a:{x:400,y:490},b:{x:400,y:612}});
});
it('a manual native move takes ownership back and replaces the animated position',()=>{
 const w=make();w.update({...w.scene,boards:[{x:170,y:120,w:55,h:100}]});run(w,.5);
 w.update({...w.scene,icons:w.scene.icons.map(i=>i.id==='a'?{...i,x:450,y:250,home:{x:450,y:250},pinned:true}:i)});
 expect(w.targets.a).toEqual({x:450,y:250});expect(w.bodies.get('a')!.active).toBe(false);expect(w.bodies.get('a')!.angle).toBe(0);
});
it('crowded groups and exchanged neighbors yield in order and all return to their own homes',()=>{
 const s=scene();s.iconSize=55;s.areas=[{x:0,y:0,w:1920,h:1020}];
 const points=[[115,246,216,112],[210,2,183,163],[210,124,162,108],[400,124,463,150],[495,124,432,98],[305,2,305,2],[305,124,305,124],[115,2,115,2],[115,124,115,124]];
 s.icons=points.map(([hx,hy,x,y],i)=>({id:String(i),name:String(i),image:'',home:{x:hx,y:hy},x,y}));
 const w=make(s,squareShape(55));run(w,12);expect(w.allHome).toBe(true);
 for(const icon of s.icons)expect(w.targets[icon.id]).toEqual(icon.home);
});
