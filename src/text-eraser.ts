import {newId} from './model';
import type {Point} from './model';
import {compact} from './paper-model';
import type {PaperPart,PaperRow} from './paper-model';

export type EraserMode='ink'|'text'|null;
export type TextBox={x:number;y:number;w:number;h:number};
// Distance from the whole mouse segment to a glyph rectangle, so a fast drag
// still erases characters between two pointer events. Corners stay circular.
export function touchesText(from:Point,to:Point,box:TextBox,radius=10):boolean {
  const right=box.x+box.w,bottom=box.y+box.h,dx=to.x-from.x,dy=to.y-from.y;
  let lo=0,hi=1;
  for(const [value,delta,min,max] of [[from.x,dx,box.x,right],[from.y,dy,box.y,bottom]]){
    if(Math.abs(delta)<1e-9){if(value<min||value>max){lo=1;hi=0;break;}}
    else{const a=(min-value)/delta,b=(max-value)/delta;lo=Math.max(lo,Math.min(a,b));hi=Math.min(hi,Math.max(a,b));}
  }
  if(lo<=hi)return true;
  const pointDistance=(p:Point)=>Math.hypot(Math.max(box.x-p.x,0,p.x-right),Math.max(box.y-p.y,0,p.y-bottom));
  if(Math.min(pointDistance(from),pointDistance(to))<=radius)return true;
  const length=dx*dx+dy*dy;
  for(const p of [{x:box.x,y:box.y},{x:right,y:box.y},{x:box.x,y:bottom},{x:right,y:bottom}]){
    const t=length?Math.max(0,Math.min(1,((p.x-from.x)*dx+(p.y-from.y)*dy)/length)):0;
    if(Math.hypot(p.x-from.x-t*dx,p.y-from.y-t*dy)<=radius)return true;
  }
  return false;
}

type Cell={part:PaperPart;x:number;width:number;target?:number};
type RowLayout={rows:PaperRow[];cells:Cell[][]};
export type TextEraserSession={erase:(from:Point,to:Point)=>boolean;result:()=>PaperRow[];changed:()=>boolean};

// Cache the original glyph rectangles once per gesture. Only affected logical
// rows are projected to their visual lines; erased glyphs become exact gaps.
// This also preserves the positions of later soft-wrapped text and file atoms.
export function captureTextEraser(editor:HTMLElement,origin:DOMRect,rows:PaperRow[],spacing:number):TextEraserSession {
  const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'}),layouts=new Map<string,RowLayout>();
  const targets:{box:TextBox;row:string}[]=[],removed=new Set<number>(),affected=new Set<string>();
  const style=getComputedStyle(editor),left=editor.getBoundingClientRect().left+parseFloat(style.paddingLeft),right=editor.getBoundingClientRect().right-parseFloat(style.paddingRight);
  for(const row of rows){
    const line=[...editor.children].find(n=>(n as HTMLElement).dataset.row===row.id) as HTMLElement|undefined;if(!line)continue;
    const top=line.getBoundingClientRect().top,count=Math.max(row.height,Math.round(line.getBoundingClientRect().height/spacing)),cells:Cell[][]=Array.from({length:count},()=>[]);
    const add=(part:PaperPart,rect:DOMRect,erasable=false)=>{
      const index=Math.max(0,Math.min(count-1,Math.floor((rect.top-top+.25)/spacing)));
      const width='text'in part&&!part.text.trim()?Math.min(rect.width,Math.max(0,right-rect.left)):rect.width;
      const cell:Cell={part,x:rect.left-left,width};
      if(erasable){cell.target=targets.length;targets.push({row:row.id,box:{x:rect.left-origin.left,y:rect.top-origin.top,w:rect.width,h:rect.height}});}
      cells[index].push(cell);
    };
    const visit=(node:Node)=>{
      if(node instanceof HTMLElement&&node.dataset.atom){const rect=node.getBoundingClientRect(),css=getComputedStyle(node),marginLeft=parseFloat(css.marginLeft),marginRight=parseFloat(css.marginRight);add({itemId:node.dataset.atom},new DOMRect(rect.left-marginLeft,rect.top,rect.width+marginLeft+marginRight,rect.height));return;}
      if(node instanceof HTMLElement&&node.dataset.gap&&/^ +$/.test(node.textContent??'')){const rect=node.getBoundingClientRect();add({text:node.textContent!,width:rect.width},rect);return;}
      if(node.nodeType===Node.TEXT_NODE){for(const {segment,index} of segmenter.segment(node.textContent??'')){const range=document.createRange();range.setStart(node,index);range.setEnd(node,index+segment.length);add({text:segment.replace(/\u00a0/g,' ')},range.getBoundingClientRect(),!!segment.trim());}return;}
      for(const child of node.childNodes)visit(child);
    };visit(line);
    // Range rectangles can overlap by one subpixel. Use the next glyph's start
    // as the advance, otherwise repeatedly erased letters accumulate drift.
    for(const visual of cells)visual.forEach((cell,i)=>{const next=visual[i+1];if(next&&'text'in cell.part)cell.width=Math.max(0,next.x-cell.x);});
    layouts.set(row.id,{cells,rows:cells.map((_,i)=>({id:i?newId():row.id,parts:[],height:1}))});
  }
  const gap=(width:number):PaperPart[]=>{width=Math.max(0,Math.round(width*64)/64);return width?[{text:' ',width}]:[];};
  return {
    changed:()=>removed.size>0,
    erase:(from,to)=>{let changed=false;targets.forEach((t,i)=>{if(!removed.has(i)&&touchesText(from,to,t.box)){removed.add(i);affected.add(t.row);changed=true;}});return changed;},
    result:()=>rows.flatMap(row=>{
      const layout=layouts.get(row.id);if(!affected.has(row.id)||!layout)return [row];
      return layout.rows.map((line,i)=>{let end=0;const parts:PaperPart[]=[];
        for(const cell of layout.cells[i]){
          if(cell.x>end+.03)parts.push(...gap(cell.x-end));
          const erase=cell.target!==undefined&&removed.has(cell.target);
          parts.push(...(erase||('text'in cell.part&&!cell.part.text.trim())?gap(cell.width):[cell.part]));end=cell.x+cell.width;
        }
        return {...line,parts:compact(parts)};
      });
    })
  };
}
