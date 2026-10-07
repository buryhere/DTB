import {newId} from './model';
import type {Point} from './model';
import type {InkStroke} from './paper-model';
type Interval=[number,number];
const point=(a:Point,b:Point,t:number):Point=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});
const equal=(a:Point,b:Point)=>Math.hypot(a.x-b.x,a.y-b.y)<.001;
function circle(a:Point,b:Point,c:Point,r:number):Interval|null{
  const x=a.x-c.x,y=a.y-c.y,dx=b.x-a.x,dy=b.y-a.y,A=dx*dx+dy*dy,B=2*(x*dx+y*dy),C=x*x+y*y-r*r;
  if(A<1e-12)return C<=0?[0,1]:null;const d=B*B-4*A*C;if(d<0)return null;
  const lo=Math.max(0,(-B-Math.sqrt(d))/(2*A)),hi=Math.min(1,(-B+Math.sqrt(d))/(2*A));return lo<=hi?[lo,hi]:null;
}
function linear(value:number,delta:number,lo:number,hi:number):Interval|null{
  if(Math.abs(delta)<1e-12)return value>=lo&&value<=hi?[0,1]:null;
  const x=(lo-value)/delta,y=(hi-value)/delta,a=Math.max(0,Math.min(x,y)),b=Math.min(1,Math.max(x,y));return a<=b?[a,b]:null;
}
function covered(a:Point,b:Point,from:Point,to:Point,r:number):Interval[]{
  const cuts=[circle(a,b,from,r),circle(a,b,to,r)].filter((v):v is Interval=>!!v),dx=to.x-from.x,dy=to.y-from.y,d=Math.hypot(dx,dy);
  if(d>.001){const ux=dx/d,uy=dy/d,x=a.x-from.x,y=a.y-from.y,sx=b.x-a.x,sy=b.y-a.y;
    const along=linear(x*ux+y*uy,sx*ux+sy*uy,0,d),across=linear(-x*uy+y*ux,-sx*uy+sy*ux,-r,r);
    if(along&&across){const lo=Math.max(along[0],across[0]),hi=Math.min(along[1],across[1]);if(lo<=hi)cuts.push([lo,hi]);}}
  cuts.sort((a,b)=>a[0]-b[0]);const merged:Interval[]=[];for(const c of cuts){const last=merged[merged.length-1];if(last&&c[0]<=last[1]+1e-8)last[1]=Math.max(last[1],c[1]);else merged.push(c);}return merged;
}
// Clip polylines against the entire swept eraser capsule, including fast drags.
export function eraseInk(strokes:InkStroke[],from:Point,to:Point,radius=10):InkStroke[]{
  const result:InkStroke[]=[];
  for(const stroke of strokes){let changed=false,current:Point[]=[],pieces:Point[][]=[];
    const close=()=>{if(current.length>1)pieces.push(current);current=[];};
    for(let i=1;i<stroke.points.length;i++){const a=stroke.points[i-1],b=stroke.points[i],cuts=covered(a,b,from,to,radius);if(cuts.length)changed=true;
      const kept:Interval[]=[];let start=0;for(const [lo,hi] of cuts){if(lo>start+1e-8)kept.push([start,lo]);start=Math.max(start,hi);}if(start<1-1e-8)kept.push([start,1]);
      if(!kept.length){close();continue;}for(const [lo,hi] of kept){const p=point(a,b,lo),q=point(a,b,hi);if(current.length&&!equal(current[current.length-1],p))close();if(!current.length)current.push(p);current.push(q);if(hi<1-1e-8)close();}
    }close();if(!changed)result.push(stroke);else pieces.forEach((points,i)=>result.push({...stroke,id:i?newId():stroke.id,points}));
  }return result;
}
