import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { cutGesture, clipStroke } from './model';
import type { Point } from './model';
import './App.css';

export type CutScene = { token: string; label: string; origin: Point; scale: number; lineHeight: number; paper: Point & {w:number;h:number}; board: Point & {w:number;h:number} };
type Gesture = ReturnType<typeof cutGesture>;
export function CutSurface({ scene, finish }: {scene:CutScene;finish:(gesture:Gesture)=>void}) {
  const [trail,setTrail]=useState<Point[]>([]), [line,setLine]=useState<Gesture>(null);
  const [hint,setHint]=useState('按住左键划过纸面 · 按右键取消');
  const drawing=useRef(false), ink=useRef<Point[]>([]), ended=useRef(false);
  const cancelling=useRef(false),cancelFrame=useRef(0);
  useEffect(()=>()=>cancelAnimationFrame(cancelFrame.current),[]);
  const local=(point:Point)=>({x:(point.x-scene.origin.x)/scene.scale,y:(point.y-scene.origin.y)/scene.scale});
  const paperOrigin=local(scene.paper), boardOrigin=local(scene.board);
  function end(gesture:Gesture) { if(ended.current)return;ended.current=true;finish(gesture); }
  function move(event:ReactPointerEvent<HTMLDivElement>) {
    if(!drawing.current)return;
    ink.current.push({x:scene.origin.x+event.clientX*scene.scale,y:scene.origin.y+event.clientY*scene.scale});
    const stroke=clipStroke(ink.current,scene.paper);
    setTrail(ink.current.slice(-240).map(local));setLine(cutGesture(stroke,scene.paper.w,scene.paper.h,scene.lineHeight));
  }
  return <div className="cut-glass" aria-label="屏幕裁剪区域" onContextMenu={e=>{e.preventDefault();e.stopPropagation();cancelAnimationFrame(cancelFrame.current);end(null);}}
    onPointerDown={e=>{
      e.preventDefault();if(e.button===2){e.stopPropagation();cancelling.current=true;e.currentTarget.setPointerCapture(e.pointerId);return;}if(e.button!==0)return;
      drawing.current=true;ink.current=[{x:scene.origin.x+e.clientX*scene.scale,y:scene.origin.y+e.clientY*scene.scale}];setTrail(ink.current.map(local));setLine(null);
      e.currentTarget.setPointerCapture(e.pointerId);
    }} onPointerMove={move} onPointerUp={e=>{
      if(e.button===2&&cancelling.current){e.preventDefault();e.stopPropagation();cancelling.current=false;if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);
        // Keep the window through mouse-up and swallow its contextmenu event.
        // Two frames also cover browsers which suppress that event after capture.
        cancelFrame.current=requestAnimationFrame(()=>{cancelFrame.current=requestAnimationFrame(()=>end(null));});return;}
      if(e.button!==0||!drawing.current)return;move(e);drawing.current=false;
      if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);
      const gesture=cutGesture(clipStroke(ink.current,scene.paper),scene.paper.w,scene.paper.h,scene.lineHeight);
      if(gesture)end(gesture);else {setHint('划过纸面的大半部分进行裁剪 · 按右键取消');setTrail([]);setLine(null);}
    }} onPointerCancel={()=>{drawing.current=false;setTrail([]);setLine(null);}}>
    <div className="cut-hint" style={{left:boardOrigin.x,top:boardOrigin.y,width:scene.board.w/scene.scale,height:scene.board.h/scene.scale}}>{hint}</div>
    <svg className="cut-overlay"><polyline className="cut-trail" points={trail.map(p=>`${p.x},${p.y}`).join(' ')} />
      {line && (line.direction==='horizontal'?<line className="cut-line" x1={paperOrigin.x} x2={paperOrigin.x+scene.paper.w/scene.scale} y1={paperOrigin.y+line.coordinate/scene.scale} y2={paperOrigin.y+line.coordinate/scene.scale}/>:<line className="cut-line" x1={paperOrigin.x+line.coordinate/scene.scale} x2={paperOrigin.x+line.coordinate/scene.scale} y1={paperOrigin.y} y2={paperOrigin.y+scene.paper.h/scene.scale}/>)}</svg>
  </div>;
}
export default function CutOverlay() {
  const [scene,setScene]=useState<CutScene|null>(null),[error,setError]=useState('');
  useEffect(()=>{document.body.style.padding='0';let live=true;invoke<CutScene|null>('cut_scene').then(s=>{if(live)setScene(s)}).catch(e=>setError(String(e)));return()=>{live=false;};},[]);
  return scene?<CutSurface scene={scene} finish={gesture=>{invoke('finish_cut',{token:scene.token,gesture}).catch(e=>setError(String(e)));}}/>:<div>{error}</div>;
}
