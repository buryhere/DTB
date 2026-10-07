import {clipStroke,newId} from './model';
import type {Point} from './model';
import {compact} from './paper-model';
import type {InkStroke,PaperPart,PaperRow} from './paper-model';
import type {TextBox} from './text-eraser';

export type PaperCell={part:PaperPart;x:number;y:number;width:number;source?:{id:string;offset:number}};
export type PaperLayout={rows:PaperRow[];cells:PaperCell[];left:number;right:number;sourceRows?:{id:string;y:number}[]};
const visible=(cell:PaperCell)=>'itemId'in cell.part||!!cell.part.text.trim();
const overlaps=(a:TextBox,b:TextBox)=>a.x<b.x+b.w-.1&&a.x+a.w>b.x+.1&&a.y<b.y+b.h-.1&&a.y+a.h>b.y+.1;

// Project soft wraps to visual rows once, using real glyph advances and atom
// margins. Exact gaps let a partial selection move without shifting its peers.
export function capturePaperLayout(editor:HTMLElement,origin:DOMRect,rows:PaperRow[],spacing:number):PaperLayout {
  const style=getComputedStyle(editor),rect=editor.getBoundingClientRect();
  const left=rect.left+parseFloat(style.paddingLeft)-origin.left,right=rect.right-parseFloat(style.paddingRight)-origin.left;
  const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'}),cells:PaperCell[]=[],visualRows:PaperRow[]=[],sourceRows:{id:string;y:number}[]=[];
  for(const row of rows){
    const line=[...editor.children].find(n=>(n as HTMLElement).dataset.row===row.id) as HTMLElement|undefined;if(!line)continue;
    const top=line.getBoundingClientRect().top,count=Math.max(row.height,Math.round(line.getBoundingClientRect().height/spacing));let offset=0;sourceRows.push({id:row.id,y:top-origin.top});
    for(let i=0;i<count;i++)visualRows.push({id:i?newId():row.id,parts:[],height:1});
    const add=(part:PaperPart,box:DOMRect)=>{const index=Math.max(0,Math.min(count-1,Math.floor((box.top-top+.25)/spacing)));
      const width='text'in part&&!part.text.trim()?Math.min(box.width,Math.max(0,right+origin.left-box.left)):box.width;
      cells.push({part,x:box.left-origin.left,y:top-origin.top+index*spacing,width,source:{id:row.id,offset}});offset+='text'in part?part.text.length:1;};
    const visit=(node:Node)=>{
      if(node instanceof HTMLElement&&node.dataset.atom){const r=node.getBoundingClientRect(),css=getComputedStyle(node),l=parseFloat(css.marginLeft),rMargin=parseFloat(css.marginRight);add({itemId:node.dataset.atom},new DOMRect(r.left-l,r.top,r.width+l+rMargin,r.height));return;}
      if(node instanceof HTMLElement&&node.dataset.gap&&/^ +$/.test(node.textContent??'')){const r=node.getBoundingClientRect();add({text:node.textContent!,width:r.width},r);return;}
      if(node.nodeType===Node.TEXT_NODE){for(const {segment,index} of segmenter.segment(node.textContent??'')){const range=document.createRange();range.setStart(node,index);range.setEnd(node,index+segment.length);add({text:segment.replace(/\u00a0/g,' ')},range.getBoundingClientRect());}return;}
      for(const child of node.childNodes)visit(child);
    };visit(line);
  }
  cells.forEach((cell,i)=>{const next=cells[i+1];if(next&&Math.abs(next.y-cell.y)<.5&&'text'in cell.part)cell.width=Math.max(0,next.x-cell.x);});
  return {rows:visualRows,cells,left,right,sourceRows};
}

// Resize must inspect the OLD visual layout, before any soft wrap changes.
// Preserve all whitespace and map logical selection offsets to the new visual
// rows. This keeps native carets, backwards selections and IME text usable.
export function freezePaperLayout(layout:PaperLayout,spacing:number){
  const cellsByLine=Array.from({length:layout.rows.length},()=>[] as PaperCell[]);
  for(const cell of layout.cells){const index=Math.max(0,Math.round(cell.y/spacing));(cellsByLine[index]??=[]).push(cell);}
  const positions=new Map<PaperCell,{id:string;offset:number}>();
  const rows=cellsByLine.map((cells,i)=>{let end=layout.left,offset=0;const parts:PaperPart[]=[],id=layout.rows[i]?.id??newId();
    for(const cell of cells.sort((a,b)=>a.x-b.x)){const gap=Math.round(Math.max(0,cell.x-end)*64)/64;if(gap>.03){parts.push({text:' ',width:gap});offset++;}
      positions.set(cell,{id,offset});const part='text'in cell.part&&/^ +$/.test(cell.part.text)?{text:cell.part.text,width:cell.width}:cell.part;
      parts.push(part);offset+='text'in part?part.text.length:1;end=cell.x+cell.width;}
    return {id,parts:compact(parts),height:1} as PaperRow;});
  const remap=(point:{id:string;offset:number})=>{const cells=layout.cells.filter(c=>c.source?.id===point.id);
    const cell=cells.find(c=>point.offset>=c.source!.offset&&point.offset<c.source!.offset+('text'in c.part?c.part.text.length:1))??cells[cells.length-1];
    if(cell){const target=positions.get(cell)!;return {...target,offset:target.offset+Math.max(0,Math.min(point.offset-cell.source!.offset,'text'in cell.part?cell.part.text.length:1))};}
    const source=layout.sourceRows?.find(r=>r.id===point.id),row=source?rows[Math.round(source.y/spacing)]:rows.find(r=>r.id===point.id);return {id:row?.id??rows[0].id,offset:0};};
  // Reserve the artwork and actual writing extent, not the former empty border.
  const width=Math.max(layout.left,...layout.cells.filter(visible).map(c=>c.x+c.width))+12+1;
  return {rows,remap,width};
}

export function rowsFromCells(layout:PaperLayout,cells:PaperCell[],spacing:number):PaperRow[]{
  const content=cells.filter(visible),count=Math.max(layout.rows.length,...content.map(c=>Math.round(c.y/spacing)+1),1);
  const lines=Array.from({length:count},()=>[] as PaperCell[]);for(const c of content)lines[Math.max(0,Math.round(c.y/spacing))].push(c);
  return lines.map((line,i)=>{let end=layout.left;const parts:PaperPart[]=[];
    for(const cell of line.sort((a,b)=>a.x-b.x)){const gap=Math.round(Math.max(0,cell.x-end)*64)/64;if(gap>.03)parts.push({text:' ',width:gap});parts.push(cell.part);end=cell.x+cell.width;}
    return {id:layout.rows[i]?.id??newId(),parts:compact(parts),height:1};});
}

export type PaperSelection={layout:PaperLayout;box:TextBox;cells:PaperCell[];rest:PaperCell[];ink:InkStroke[];restInk:InkStroke[]};
export function selectPaper(layout:PaperLayout,ink:InkStroke[],box:TextBox,spacing:number):PaperSelection|null {
  const selected=layout.cells.filter(c=>visible(c)&&overlaps(box,{x:c.x,y:c.y,w:c.width,h:spacing}));
  const selectedInk=ink.filter(s=>s.points.some(p=>p.x>=box.x&&p.x<=box.x+box.w&&p.y>=box.y&&p.y<=box.y+box.h)||clipStroke(s.points,box).length>0);
  if(!selected.length&&!selectedInk.length)return null;
  // Include the complete intersected strokes and glyphs in the carried box.
  const x=Math.min(box.x,...selected.map(c=>c.x),...selectedInk.flatMap(s=>s.points.map(p=>p.x)));
  const y=Math.max(0,Math.min(box.y,...selected.map(c=>c.y),...selectedInk.flatMap(s=>s.points.map(p=>p.y))));
  const right=Math.max(box.x+box.w,...selected.map(c=>c.x+c.width),...selectedInk.flatMap(s=>s.points.map(p=>p.x)));
  const bottom=Math.max(box.y+box.h,...selected.map(c=>c.y+spacing),...selectedInk.flatMap(s=>s.points.map(p=>p.y)));
  return {layout,box:{x,y,w:right-x,h:bottom-y},cells:selected,rest:layout.cells.filter(c=>!selected.includes(c)),ink:selectedInk,restInk:ink.filter(s=>!selectedInk.includes(s))};
}
export function movePaperSelection(selection:PaperSelection,mouse:Point,spacing:number){
  const {box,layout}=selection;
  const inkPoints=selection.ink.flatMap(s=>s.points);
  const minDx=Math.max(...selection.cells.map(c=>layout.left-c.x),...inkPoints.map(p=>-p.x),-Infinity);
  const maxDx=Math.min(...selection.cells.map(c=>layout.right-c.x-c.width),...inkPoints.map(p=>layout.right+12-p.x),Infinity);
  const dx=Math.max(minDx,Math.min(maxDx,mouse.x-box.w/2-box.x));
  const dy=Math.max(0,Math.round((mouse.y-box.h/2-box.y)/spacing)*spacing+box.y)-box.y;
  // The displacement itself must be a multiple of the line height, including
  // selections whose drawn rectangle started halfway down a line.
  const snappedDy=Math.max(-Math.floor(box.y/spacing)*spacing,Math.round(dy/spacing)*spacing);
  const cells=selection.cells.map(c=>({...c,x:c.x+dx,y:c.y+snappedDy}));
  const ink=selection.ink.map(s=>({...s,points:s.points.map(p=>({x:p.x+dx,y:p.y+snappedDy}))}));
  const valid=cells.every(c=>!selection.rest.some(r=>visible(r)&&overlaps({x:c.x,y:c.y,w:c.width,h:spacing},{x:r.x,y:r.y,w:r.width,h:spacing})));
  return {cells,ink,valid,box:{...box,x:box.x+dx,y:box.y+snappedDy},rows:()=>rowsFromCells(layout,[...selection.rest,...cells],spacing),allInk:[...selection.restInk,...ink]};
}

// Only trim the outer empty tail. Interior gaps between notes remain buffers,
// and ink and an active writing caret also reserve the rows they occupy.
export function fitPaperRows(rows:PaperRow[],ink:InkStroke[],minRows:number,spacing:number,caretId?:string):PaperRow[]{
  const last=rows.reduce((last,r,i)=>r.id===caretId||r.parts.some(p=>'itemId'in p||!!p.text.trim())?i:last,-1);
  const result=rows.slice(0,last+1).map(r=>{if(r.id===caretId)return r;const parts=[...r.parts];while(parts.length&&'text'in parts[parts.length-1]&&!((parts[parts.length-1] as {text:string}).text.trim()))parts.pop();const tail=parts[parts.length-1];if(tail&&'text'in tail)parts[parts.length-1]={text:tail.text.trimEnd()};return {...r,parts};});
  let count=result.reduce((n,r)=>n+r.height,0);
  const needed=Math.max(minRows,...ink.flatMap(s=>s.points.map(p=>Math.floor((p.y+2)/spacing)+1)),1);
  while(count<needed){result.push(rows[result.length]&&rows[result.length].height===1?{...rows[result.length],parts:[]}: {id:newId(),parts:[],height:1});count++;}
  return result;
}
