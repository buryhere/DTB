import {forwardRef,useEffect,useImperativeHandle,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {FileTile} from './file-tile';
import {filePresentation} from './file-presentation';
import {newId} from './model';
import type {Item,Point} from './model';
import {blank,compact,length,migrateRows,mirrorItems,preserveBuffers,preserveInlineBuffers,sliceParts} from './paper-model';
import {eraseInk} from './ink';
import {captureTextEraser} from './text-eraser';
import {caretScroll,horizontalWheel} from './paper-scroll';
import {capturePaperLayout,fitPaperRows,freezePaperLayout,movePaperSelection,rowsFromCells,selectPaper} from './paper-selection';
import type {PaperSelection} from './paper-selection';
import type {TextBox} from './text-eraser';
import type {EraserMode,TextEraserSession} from './text-eraser';
import type {InkStroke,PaperPart,PaperRow} from './paper-model';

type Cursor={id:string;offset:number};type Selection={anchor:Cursor;focus:Cursor};
export type PaperSnapshot={rows:PaperRow[];ink:InkStroke[];items:Item[]};
export type PaperEditorHandle={flush:()=>PaperSnapshot;undo:()=>void;redo:()=>void;focusEnd:()=>void;focusWriting:()=>void;insertItems:(items:Item[])=>void;resetHistory:()=>void};
type Props={boardId:string;rows?:PaperRow[];ink?:InkStroke[];items:Item[];spacing:number;disabled:boolean;pencil:boolean;marquee:boolean;eraser:EraserMode;onChange:(rows:PaperRow[],ink:InkStroke[],items:Item[])=>void;onHistory:(canUndo:boolean)=>void;onOpen:(item:Item)=>void;onSelect:(item:Item)=>void};
export const PaperEditor=forwardRef<PaperEditorHandle,Props>(function PaperEditor(props,ref){
  const root=useRef<HTMLDivElement>(null),wrapper=useRef<HTMLDivElement>(null),latest=useRef(props);latest.current=props;
  const state=useRef<PaperSnapshot>({rows:[],ink:[],items:[]}),initialized=useRef(false),lastSpacing=useRef(props.spacing),composing=useRef(false);
  const receivedRows=useRef(props.rows),publishedRows=useRef(new WeakSet<PaperRow[]>()),receivedInk=useRef(props.ink),publishedInk=useRef(new WeakSet<InkStroke[]>());
  const cursor=useRef<Selection|null>(null),undoStack=useRef<PaperSnapshot[]>([]),redoStack=useRef<PaperSnapshot[]>([]);
  const [hosts,setHosts]=useState<{node:HTMLElement;id:string}[]>([]),[height,setHeight]=useState(400),[ink,setInk]=useState<InkStroke[]>([]);
  const drawing=useRef<{points:Point[];straight:boolean;eraser:boolean;workingInk:InkStroke[]}|null>(null),[draft,setDraft]=useState<InkStroke[]>([]);
  const textErasing=useRef<{session:TextEraserSession;last:Point;pointer:number;surface:HTMLElement}|null>(null);
  const marquee=useRef<{start:Point;box:TextBox;pointer:number;surface:HTMLElement;selection?:PaperSelection;placing?:boolean}|null>(null);
  const marqueeMouse=useRef<Point|null>(null);
  const [marqueeBox,setMarqueeBox]=useState<TextBox|null>(null),[groupPreview,setGroupPreview]=useState<ReturnType<typeof movePaperSelection>|null>(null);
  const metrics=useRef<CanvasRenderingContext2D|null>(null);
  const viewportWidth=useRef(0);
  const drag=useRef<{id:string;pointer:number;x:number;y:number;dx:number;dy:number;active:boolean;node:HTMLElement}|null>(null);
  const [dragPreview,setDragPreview]=useState<{id:string;x:number;y:number}|null>(null),lastDrag=useRef(0);
  const spacing=props.spacing;
  const paddingRows=(rows:PaperRow[],nextInk=state.current.ink,keepCaret=true)=>fitPaperRows(rows,nextInk,Math.max(3,Math.ceil((wrapper.current?.parentElement?.clientHeight??400)/latest.current.spacing)),latest.current.spacing,keepCaret&&!latest.current.pencil&&!latest.current.eraser&&!latest.current.marquee?cursor.current?.focus.id:undefined);
  function writingWidth(){const style=getComputedStyle(root.current!);return Math.max(1,root.current!.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight));}
  function sizedRows(rows:PaperRow[]){const width=writingWidth();return rows.map(row=>({...row,wrapWidth:row.wrapWidth??width}));}
  function measure(parts:PaperPart[]){
    const context=metrics.current??(metrics.current=document.createElement('canvas').getContext('2d')!);
    const style=getComputedStyle(root.current!);context.font=`${style.fontSize} ${style.fontFamily}`;
    return parts.reduce((sum,p)=>{if('text'in p)return sum+(p.width??context.measureText(p.text).width);
      const atom=root.current?.querySelector<HTMLElement>(`[data-atom="${CSS.escape(p.itemId)}"]`),item=state.current.items.find(i=>i.id===p.itemId);return sum+(atom?.getBoundingClientRect().width??(item?filePresentation(item,latest.current.spacing).width:Math.min(32,latest.current.spacing-4)))+8;},0);
  }
  function readParts(node:Node):PaperPart[]{
    if(node.nodeType===Node.TEXT_NODE)return [{text:(node.textContent??'').replace(/\u00a0/g,' ')}];
    if(node instanceof HTMLElement&&node.dataset.atom)return [{itemId:node.dataset.atom}];
    if(node instanceof HTMLElement&&node.dataset.gap){const unit=Number(node.dataset.gap),text=(node.textContent??'').replace(/\u00a0/g,' ');
      if(/^ *$/.test(text))return text?[{text,width:text.length*unit}]:[];
      const original=Number(node.dataset.count),leading=Math.min(original,text.match(/^ */)![0].length),trailing=Math.min(Math.max(0,original-leading),text.match(/ *$/)![0].length);
      return [...(leading?[{text:text.slice(0,leading),width:leading*unit}]:[]),{text:text.slice(leading,text.length-trailing)},...(trailing?[{text:text.slice(text.length-trailing),width:trailing*unit}]:[])];}
    if(node instanceof HTMLBRElement)return [];
    return compact([...node.childNodes].flatMap(readParts));
  }
  function readDom():PaperRow[]{
    const currentSelection=window.getSelection();const anchor=currentSelection?.anchorNode,anchorOffset=currentSelection?.anchorOffset,focus=currentSelection?.focusNode,focusOffset=currentSelection?.focusOffset;
    let wrapped=false;
    for(const node of [...root.current!.childNodes]) {
      if(node instanceof HTMLDivElement)continue;
      const line=document.createElement('div');line.className='editor-line';line.dataset.row=newId();root.current!.insertBefore(line,node);line.append(node);wrapped=true;
    }
    if(wrapped&&anchor&&focus&&root.current!.contains(anchor)&&root.current!.contains(focus))currentSelection?.setBaseAndExtent(anchor,anchorOffset??0,focus,focusOffset??0);
    const ids=new Set<string>();return [...root.current!.children].filter(n=>n instanceof HTMLElement).map(n=>{
      const element=n as HTMLElement;let id=element.dataset.row!;if(!id||ids.has(id)){id=newId();element.dataset.row=id;}ids.add(id);
      return {id,parts:readParts(element),height:Math.max(1,Math.ceil((element.getBoundingClientRect().height-.5)/latest.current.spacing)),wrapWidth:parseFloat(element.style.width)||writingWidth()};
    });
  }
  function locate(node:Node,offset:number):Cursor|null{
    const line=(node instanceof HTMLElement?node:node.parentElement)?.closest<HTMLElement>('[data-row]');
    if(!line){if(node===root.current){const rows=[...root.current.children] as HTMLElement[];const el=rows[Math.min(offset,rows.length-1)];return el?{id:el.dataset.row!,offset:offset>=rows.length?length(readParts(el)):0}:null;}return null;}
    let count=0,found=false;
    const visit=(n:Node)=>{if(found)return;if(n===node){if(n.nodeType===Node.TEXT_NODE)count+=offset;else count+=length([...n.childNodes].slice(0,offset).flatMap(readParts));found=true;return;}
      if(n instanceof HTMLElement&&n.dataset.atom){if(n.contains(node)){count+=offset?1:0;found=true;}else count++;return;}if(n.nodeType===Node.TEXT_NODE){count+=n.textContent?.length??0;return;}for(const c of n.childNodes)visit(c);};
    visit(line);return {id:line.dataset.row!,offset:count};
  }
  function selection():Selection|null{const s=window.getSelection();if(!s?.anchorNode||!s.focusNode||!root.current?.contains(s.anchorNode))return cursor.current;const anchor=locate(s.anchorNode,s.anchorOffset),focus=locate(s.focusNode,s.focusOffset);return anchor&&focus?{anchor,focus}:cursor.current;}
  function restore(s:Selection|null){if(!s||!root.current)return;const endpoint=(p:Cursor):[Node,number]=>{
    const line=[...root.current!.children].find(n=>(n as HTMLElement).dataset.row===p.id)??root.current!.firstElementChild!;let left=p.offset;
    const find=(parent:Node):[Node,number]|null=>{for(const node of parent.childNodes){if(node instanceof HTMLElement&&node.dataset.atom){if(left===0)return [parent,[...parent.childNodes].indexOf(node)];left--;}else if(node.nodeType===Node.TEXT_NODE){const n=node.textContent?.length??0;if(left<=n)return [node,left];left-=n;}else {const result=find(node);if(result)return result;}}return null;};const found=find(line);if(found)return found;
    // The placeholder BR is not content. A caret after it can jump to the root
    // or create a second visual line when the next character is inserted.
    const placeholder=[...line.childNodes].findIndex(n=>n instanceof HTMLBRElement);
    return [line,placeholder>=0?placeholder:line.childNodes.length];};const a=endpoint(s.anchor),f=endpoint(s.focus);window.getSelection()?.setBaseAndExtent(a[0],a[1],f[0],f[1]);cursor.current=s;
  }
  function paintLine(line:HTMLElement,parts:PaperPart[]){
    const existing=new Map([...line.querySelectorAll<HTMLElement>('[data-atom]')].map(node=>[node.dataset.atom!,node]));const atoms:{node:HTMLElement;id:string}[]=[],nodes:Node[]=[];
    for(const part of parts){if('text'in part)nodes.push(textNode(part));
      else {const node=existing.get(part.itemId)??document.createElement('span');node.contentEditable='false';node.className='paper-atom';node.dataset.atom=part.itemId;atoms.push({node,id:part.itemId});nodes.push(node);}}
    if(!nodes.length)nodes.push(document.createElement('br'));line.replaceChildren(...nodes);return atoms;
  }
  function textNode(part:{text:string;width?:number}){
    if(part.width===undefined||!/^ +$/.test(part.text))return document.createTextNode(part.text);
    const gap=document.createElement('span');gap.dataset.gap=String(part.width/part.text.length);gap.dataset.count=String(part.text.length);gap.className='paper-gap';gap.style.width=`${part.width}px`;gap.style.letterSpacing=`${part.width/part.text.length-measure([{text:' '}])}px`;gap.textContent=part.text;return gap;
  }
  function gapPart(width:number):PaperPart[]{width=Math.max(0,Math.round(width*64)/64);return width?[{text:' '.repeat(Math.max(1,Math.round(width/measure([{text:' '}])))),width}]:[];}
  function render(rows:PaperRow[],s:Selection|null){
    const nodes:HTMLElement[]=[],atoms:{node:HTMLElement;id:string}[]=[];
    const existing=new Map([...root.current!.children].map(n=>[(n as HTMLElement).dataset.row,n as HTMLElement]));
    const existingAtoms=new Map([...root.current!.querySelectorAll<HTMLElement>('[data-atom]')].map(n=>[n.dataset.atom!,n]));
    const minWidth=Math.max(0,...rows.filter(r=>!blank(r)).map(r=>(r.wrapWidth??0)+36),...state.current.ink.flatMap(s=>s.points.map(p=>p.x+3)));
    wrapper.current!.style.minWidth=`${minWidth}px`;
    for(const row of rows){const line=existing.get(row.id)??document.createElement('div');line.className='editor-line';line.dataset.row=row.id;line.style.width=`${row.wrapWidth??writingWidth()}px`;
      // Keep portal hosts and real file dimensions while moving visual rows.
      for(const part of row.parts)if('itemId'in part&&existingAtoms.has(part.itemId))line.append(existingAtoms.get(part.itemId)!);
      atoms.push(...paintLine(line,row.parts));nodes.push(line);
    }
    root.current!.replaceChildren(...nodes);setHosts(atoms);setHeight(rows.reduce((n,r)=>n+r.height,0)*latest.current.spacing);restore(s);
  }
  function publish(rows:PaperRow[],nextInk=state.current.ink){const items=mirrorItems(rows,state.current.items,latest.current.boardId,latest.current.spacing);state.current={rows,ink:nextInk,items};publishedRows.current.add(rows);publishedInk.current.add(nextInk);setInk(nextInk);latest.current.onChange(rows,nextInk,items);}
  function commit(rows:PaperRow[],s:Selection|null,nextInk=state.current.ink,remember=true){
    if(remember){undoStack.current.push(structuredClone(state.current));if(undoStack.current.length>100)undoStack.current.shift();redoStack.current=[];}
    cursor.current=s;const next=sizedRows(paddingRows(rows,nextInk));render(next,s);publish(next,nextInk);latest.current.onHistory(undoStack.current.length>0);
  }
  function inline(rows:PaperRow[],s:Selection|null){let changed=false;const before=new Map(state.current.rows.map(r=>[r.id,r]));
    for(const row of rows){const old=before.get(row.id);if(!old)continue;const adjusted=preserveInlineBuffers(old.parts,row.parts,measure,s?.focus.id===row.id?s.focus.offset:0);row.parts=adjusted.parts;
      if(s?.focus.id===row.id){if(s.anchor.id===s.focus.id&&s.anchor.offset===s.focus.offset)s.anchor.offset=adjusted.caret;s.focus.offset=adjusted.caret;}
      const line=[...root.current!.children].find(n=>(n as HTMLElement).dataset.row===row.id) as HTMLElement|undefined;
      if(line&&(JSON.stringify(row.parts)!==JSON.stringify(readParts(line))||[...line.querySelectorAll<HTMLElement>('[data-gap]')].some(g=>!/^ *$/.test(g.textContent??'')||Number(g.dataset.count)!==(g.textContent?.length??0)))){paintLine(line,row.parts);changed=true;}}
    if(changed){restore(s);return readDom();}return rows;
  }
  function input(event?:{nativeEvent?:Event}){if(composing.current||latest.current.disabled)return;let parsed=readDom();if(JSON.stringify(parsed)===JSON.stringify(state.current.rows))return;const s=selection();cursor.current=s;parsed=inline(parsed,s);const next=preserveBuffers(state.current.rows,parsed,s?.focus.id);
    const deleting=event?.nativeEvent instanceof InputEvent&&event.nativeEvent.inputType.startsWith('delete');
    const fitted=paddingRows(next,state.current.ink,!deleting);
    if(s&&!fitted.some(r=>r.id===s.focus.id)){const p={id:fitted[fitted.length-1].id,offset:0};s.anchor=p;s.focus=p;}
    if(JSON.stringify(fitted)===JSON.stringify(parsed)){undoStack.current.push(structuredClone(state.current));if(undoStack.current.length>100)undoStack.current.shift();redoStack.current=[];publish(fitted);cursor.current=s;latest.current.onHistory(true);setHeight(fitted.reduce((n,r)=>n+r.height,0)*latest.current.spacing);}
    else commit(fitted,s);
  }
  function replace(parts:PaperPart[]|string,override?:Selection){
    const rows=readDom(),s=override??selection();if(!s)return;
    const ai=rows.findIndex(r=>r.id===s.anchor.id),fi=rows.findIndex(r=>r.id===s.focus.id);if(ai<0||fi<0)return;
    const ordered=ai<fi||(ai===fi&&s.anchor.offset<=s.focus.offset);const start=ordered?s.anchor:s.focus,end=ordered?s.focus:s.anchor;const a=Math.min(ai,fi),b=Math.max(ai,fi);
    const prefix=sliceParts(rows[a].parts,0,start.offset),suffix=sliceParts(rows[b].parts,end.offset);
    const inserted=typeof parts==='string'?parts.split('\n').map(text=>[{text}] as PaperPart[]):[parts];
    const changed:PaperRow[]=inserted.map((p,i)=>({id:i===0?rows[a].id:newId(),parts:compact([...(i===0?prefix:[]),...p,...(i===inserted.length-1?suffix:[])]),height:1}));
    const last=changed[changed.length-1]!;let offset=length(last.parts)-length(suffix);
    if(changed.length===1&&a===b){const adjusted=preserveInlineBuffers(state.current.rows.find(r=>r.id===last.id)?.parts??[],last.parts,measure,offset);last.parts=adjusted.parts;offset=adjusted.caret;}
    const caret={anchor:{id:last.id,offset},focus:{id:last.id,offset}};
    const next=[...rows.slice(0,a),...changed,...rows.slice(b+1)];commit(preserveBuffers(state.current.rows,next,last.id),caret);
  }
  function history(forward:boolean){cancelMarquee();cancelTextErase();const from=forward?redoStack.current:undoStack.current,to=forward?undoStack.current:redoStack.current;const next=from.pop();if(!next)return;const refit=next.rows.some(r=>r.wrapWidth!==undefined&&Math.abs(r.wrapWidth-writingWidth())>.5);to.push(structuredClone(state.current));state.current.items=next.items;commit(next.rows,cursor.current,next.ink,false);root.current?.focus();if(refit)requestAnimationFrame(()=>resizePaper(true));}
  function focusEnd(){root.current?.focus();const rows=state.current.rows;let index=rows.length-1;while(index>0&&blank(rows[index]))index--;const row=rows[Math.min(rows.length-1,index+(blank(rows[index])?0:1))];restore({anchor:{id:row.id,offset:0},focus:{id:row.id,offset:0}});}
  function focusWriting(){root.current?.focus();if(cursor.current)restore(cursor.current);else focusEnd();}
  function cancelDrag(){const d=drag.current;if(d){d.node.classList.remove('drag-source');if(d.node.hasPointerCapture(d.pointer))d.node.releasePointerCapture(d.pointer);}drag.current=null;setDragPreview(null);}
  function cancelTextErase(){const d=textErasing.current;if(!d)return;textErasing.current=null;if(d.surface.hasPointerCapture(d.pointer))d.surface.releasePointerCapture(d.pointer);if(d.session.changed())render(state.current.rows,cursor.current);}
  function cancelMarquee(){const d=marquee.current;marquee.current=null;marqueeMouse.current=null;setMarqueeBox(null);setGroupPreview(null);if(d){if(d.surface.hasPointerCapture(d.pointer))d.surface.releasePointerCapture(d.pointer);render(state.current.rows,cursor.current);setInk(state.current.ink);}}
  function groupPoint(clientX:number,clientY:number){const r=wrapper.current!.getBoundingClientRect();return {x:clientX-r.left,y:clientY-r.top};}
  function previewGroup(p:Point){const d=marquee.current;if(!d?.selection)return;const preview=movePaperSelection(d.selection,p,latest.current.spacing);setGroupPreview(preview);setMarqueeBox(preview.box);setHeight(Math.max(state.current.rows.reduce((n,r)=>n+r.height,0)*latest.current.spacing,preview.box.y+preview.box.h+latest.current.spacing));}
  function revealCaret(){const parent=wrapper.current?.parentElement,s=window.getSelection(),p=latest.current;
    if(!parent||document.activeElement!==root.current||p.disabled||p.pencil||p.eraser||p.marquee||composing.current||!s?.isCollapsed||!s.rangeCount||!root.current!.contains(s.anchorNode))return;
    const range=s.getRangeAt(0);let rect=range.getBoundingClientRect();
    if(!rect.height){const point=selection()?.focus,line=[...root.current!.children].find(n=>(n as HTMLElement).dataset.row===point?.id);if(!line)return;const r=line.getBoundingClientRect();rect=new DOMRect(r.x,r.y,0,latest.current.spacing);}
    const box=parent.getBoundingClientRect(),next=caretScroll({left:parent.scrollLeft,top:parent.scrollTop,width:parent.scrollWidth,height:parent.scrollHeight,viewWidth:parent.clientWidth,viewHeight:parent.clientHeight},{x:rect.x-box.x,y:rect.y-box.y,w:rect.width,h:rect.height});
    parent.scrollLeft=next.left;parent.scrollTop=next.top;
  }
  function resizePaper(force=false){const parent=wrapper.current?.parentElement;if(!parent||!initialized.current||composing.current)return;
    const width=parent.clientWidth,changed=viewportWidth.current!==width;
    if(!changed&&!force){const padded=sizedRows(paddingRows(state.current.rows));if(JSON.stringify(padded)!==JSON.stringify(state.current.rows))commit(padded,selection(),state.current.ink,false);requestAnimationFrame(revealCaret);return;}
    cancelMarquee();cancelTextErase();cancelDrag();
    const s=selection(),layout=capturePaperLayout(root.current!,wrapper.current!.getBoundingClientRect(),readDom(),latest.current.spacing),frozen=freezePaperLayout(layout,latest.current.spacing);
    const minWidth=Math.max(frozen.width,...state.current.ink.flatMap(stroke=>stroke.points.map(p=>p.x+3)));
    wrapper.current!.style.minWidth=`${Math.ceil(minWidth)}px`;
    const rowWidth=Math.max(parent.clientWidth,Math.ceil(minWidth))-36;
    const next=frozen.rows.map(row=>({...row,wrapWidth:rowWidth})),mapped=s?{anchor:frozen.remap(s.anchor),focus:frozen.remap(s.focus)}:null;
    viewportWidth.current=width;commit(next,mapped,state.current.ink,false);requestAnimationFrame(revealCaret);
  }
  function refreshSize(){if(!initialized.current||!root.current||composing.current)return;const refit=state.current.rows.some(r=>!blank(r)&&r.wrapWidth!==undefined&&Math.abs(r.wrapWidth-writingWidth())>.5);if(refit||wrapper.current?.parentElement?.clientWidth!==viewportWidth.current)resizePaper(refit);}
  function eraseTextTo(clientX:number,clientY:number){const d=textErasing.current;if(!d)return;const r=wrapper.current!.getBoundingClientRect(),p={x:clientX-r.left,y:clientY-r.top};if(d.session.erase(d.last,p))render(d.session.result(),cursor.current);d.last=p;}
  function endRect(line:HTMLElement):DOMRect {let tail:Node=line;while(tail.lastChild&&!(tail instanceof HTMLElement&&tail.dataset.atom))tail=tail.lastChild;
    if(tail.nodeType===Node.TEXT_NODE){const range=document.createRange();range.setStart(tail,tail.textContent?.length??0);range.collapse(true);return range.getBoundingClientRect();}
    const rect=(tail instanceof HTMLElement?tail:line).getBoundingClientRect();return length(readParts(line))?new DOMRect(rect.x,rect.y,rect.width+(tail instanceof HTMLElement&&tail.dataset.atom?4:0),rect.height):new DOMRect(rect.x,rect.y,0,rect.height);}
  function dropItem(id:string,clientX:number,clientY:number){
    const before=readDom(),d=drag.current!,atomWidth=d.node.getBoundingClientRect().width+8;
    // Keep gap boundaries until the DOM offsets have been applied. Adjacent
    // gaps can have different per-space widths; merging them here changes cuts.
    const rows=before.map(r=>({...r,parts:r.parts.flatMap(p=>'itemId'in p&&p.itemId===id?gapPart(atomWidth):[p])}));
    // Measure the free slot with the old icon already replaced by an equal-width
    // gap. Never insert into writing: reserve whitespace without reflowing it.
    d.node.replaceWith(textNode(gapPart(atomWidth)[0] as {text:string;width:number}));
    const lines=[...root.current!.children] as HTMLElement[],content=root.current!.getBoundingClientRect(),style=getComputedStyle(root.current!);
    const left=content.left+parseFloat(style.paddingLeft),right=content.right-parseFloat(style.paddingRight);
    const target=lines.find(n=>{const r=n.getBoundingClientRect();return clientY>=r.top&&clientY<r.bottom;})??(clientY<lines[0].getBoundingClientRect().top?lines[0]:lines[lines.length-1]);
    type Slot={row:PaperRow;offset:number;count:number;prefix:number;suffix:number;score:number};
    function slots(line:HTMLElement){const row=rows.find(r=>r.id===line.dataset.row)!,top=line.getBoundingClientRect().top,result:Slot[]=[];let offset=0;
      const add=(start:number,count:number,rect:DOMRect,tail=false)=>{const lo=Math.max(left,rect.left),hi=Math.min(right,rect.right)-atomWidth;if(hi<lo-.01)return;const x=Math.max(lo,Math.min(hi,clientX)),y=top+Math.floor((rect.top-top+.1)/latest.current.spacing)*latest.current.spacing;
        result.push({row,offset:start,count,prefix:x-rect.left,suffix:tail?0:Math.max(0,rect.width-(x-rect.left)-atomWidth),score:(x-clientX)**2+(y+latest.current.spacing/2-clientY)**2});};
      const visit=(node:Node)=>{
        if(node instanceof HTMLElement&&node.dataset.atom){offset++;return;}
        if(node instanceof HTMLElement&&node.dataset.gap&&/^ +$/.test(node.textContent??'')){const count=node.textContent!.length;add(offset,count,node.getBoundingClientRect());offset+=count;return;}
        if(node.nodeType===Node.TEXT_NODE){const text=node.textContent??'';for(const match of text.matchAll(/ +/g)){let start=match.index!,first:DOMRect|null=null,last:DOMRect|null=null;
          const finish=(end:number)=>{if(first&&last)add(offset+start,end-start,new DOMRect(first.left,first.top,last.right-first.left,first.height));};
          for(let i=match.index!;i<match.index!+match[0].length;i++){const range=document.createRange();range.setStart(node,i);range.setEnd(node,i+1);const rect=range.getBoundingClientRect();if(last&&(Math.abs(rect.top-last.top)>.5||Math.abs(rect.left-last.right)>.5)){finish(i);start=i;first=null;}first??=rect;last=rect;}finish(match.index!+match[0].length);}
          offset+=text.length;return;}
        for(const child of node.childNodes)visit(child);
      };visit(line);
      const end=endRect(line),x=Math.max(left,end.right);add(length(row.parts),0,new DOMRect(x,end.top,Math.max(0,right-x),latest.current.spacing),true);return result;
    }
    const candidates=slots(target);if(!candidates.length)for(const line of lines)if(line!==target)candidates.push(...slots(line));
    const slot=candidates.sort((a,b)=>a.score-b.score)[0];if(!slot){render(before,cursor.current);return;}
    const prefix=gapPart(slot.prefix),suffix=gapPart(slot.suffix);
    slot.row.parts=compact([...sliceParts(slot.row.parts,0,slot.offset),...prefix,{itemId:id},...suffix,...sliceParts(slot.row.parts,slot.offset+slot.count)]);
    const p={id:slot.row.id,offset:slot.offset+length(prefix)+1};commit(rows,{anchor:p,focus:p});lastDrag.current=performance.now();
  }
  function insertItems(items:Item[]){if(latest.current.disabled)return;state.current.items=[...state.current.items,...items];if(!cursor.current)focusEnd();replace(items.flatMap(i=>[{itemId:i.id},{text:' '}]));}
  useImperativeHandle(ref,()=>({flush:()=>{if(!textErasing.current&&!marquee.current)refreshSize();const rows=root.current&&!textErasing.current&&!marquee.current?paddingRows(preserveBuffers(state.current.rows,readDom(),selection()?.focus.id)):state.current.rows;return {rows,ink:state.current.ink,items:mirrorItems(rows,state.current.items,latest.current.boardId,latest.current.spacing)};},undo:()=>history(false),redo:()=>history(true),focusEnd,focusWriting,insertItems,resetHistory:()=>{undoStack.current=[];redoStack.current=[];latest.current.onHistory(false);}}));
  useEffect(()=>{
    if(!root.current)return;
    // A delayed parent effect may still carry the previous keystroke's rows.
    // Acknowledge our published snapshots without reapplying them to a newer DOM.
    const external=props.rows!==receivedRows.current&&(!props.rows||!publishedRows.current.has(props.rows));receivedRows.current=props.rows;
    const externalInk=props.ink!==receivedInk.current&&(!props.ink||!publishedInk.current.has(props.ink));receivedInk.current=props.ink;
    if(initialized.current&&lastSpacing.current!==spacing){lastSpacing.current=spacing;const before=state.current.rows.map(row=>({...row,wrapWidth:writingWidth()}));render(before,cursor.current);const parsed=readDom(),next=preserveBuffers(state.current.rows,parsed,cursor.current?.focus.id);if(JSON.stringify(next)!==JSON.stringify(parsed))render(next,cursor.current);publish(next,props.ink??state.current.ink);return;}
    if(!initialized.current||external){
      cancelMarquee();cancelTextErase();
      const rows=sizedRows(paddingRows(props.rows??migrateRows(props.items,root.current.clientWidth,spacing),props.ink??[]));
      const s=initialized.current?selection():null;state.current={rows,items:props.items,ink:props.ink??[]};render(rows,s);setInk(state.current.ink);initialized.current=true;viewportWidth.current=wrapper.current!.parentElement!.clientWidth;
      // Publish viewport padding too: otherwise a parent status update treats the
      // unpadded saved rows as an external edit and replaces the DOM under the caret.
      if(!props.rows||JSON.stringify(rows)!==JSON.stringify(props.rows))publish(rows);
    }else if(externalInk){state.current.ink=props.ink??[];setInk(state.current.ink);}
  },[props.rows,props.items,props.ink,spacing]);
  useEffect(()=>{const editor=root.current!;const listener=()=>{if(editor.contains(window.getSelection()?.anchorNode??null))cursor.current=selection();};document.addEventListener('selectionchange',listener);return()=>document.removeEventListener('selectionchange',listener);},[]);
  useEffect(()=>{const open=(e:MouseEvent)=>{if(!wrapper.current?.contains(e.target as Node))return;const atom=(e.target as HTMLElement).closest<HTMLElement>('[data-atom]');const item=atom&&latest.current.items.find(i=>i.id===atom.dataset.atom);if(item&&!latest.current.disabled&&(!lastDrag.current||performance.now()-lastDrag.current>400)){e.preventDefault();latest.current.onOpen(item);}};
    // File tiles are React portals inside manually managed editable DOM. Listen
    // on the actual paper surface so capture targets and portal bubbling agree.
    document.addEventListener('dblclick',open,true);return()=>document.removeEventListener('dblclick',open,true);},[]);
  useEffect(()=>{drawing.current=null;setDraft([]);setInk(state.current.ink);cancelMarquee();cancelTextErase();cancelDrag();},[props.pencil,props.eraser,props.marquee,props.disabled,spacing]);
  useEffect(()=>{if(!props.marquee||props.disabled)return;let frame=0,last=0;
    const tick=(time:number)=>{frame=requestAnimationFrame(tick);const d=marquee.current,p=marqueeMouse.current,parent=wrapper.current?.parentElement;if(!d||!p||!parent||time-last<50)return;last=time;
      const box=parent.getBoundingClientRect(),edge=24,delta=p.y>box.bottom-edge?16:p.y<box.top+edge?-16:0;if(!delta)return;
      const before=parent.scrollTop;parent.scrollTop+=delta;if(parent.scrollTop===before)return;const point=groupPoint(p.x,p.y);
      if(d.selection)previewGroup(point);else {d.box={x:Math.min(d.start.x,point.x),y:Math.min(d.start.y,point.y),w:Math.abs(point.x-d.start.x),h:Math.abs(point.y-d.start.y)};setMarqueeBox(d.box);}
    };frame=requestAnimationFrame(tick);return()=>cancelAnimationFrame(frame);
  },[props.marquee,props.disabled]);
  useEffect(()=>{const parent=wrapper.current?.parentElement;if(!parent)return;let frame=0;const observer=new ResizeObserver(()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{if(textErasing.current||marquee.current){if(parent.clientWidth===viewportWidth.current)return;}resizePaper();});});observer.observe(parent);return()=>{observer.disconnect();cancelAnimationFrame(frame);};},[]);
  useEffect(()=>{const parent=wrapper.current?.parentElement;if(!parent)return;const wheel=(e:WheelEvent)=>{if(latest.current.disabled)return;const delta=horizontalWheel({left:parent.scrollLeft,top:parent.scrollTop,width:parent.scrollWidth,height:parent.scrollHeight,viewWidth:parent.clientWidth,viewHeight:parent.clientHeight},{x:e.deltaX,y:e.deltaY,mode:e.deltaMode,shift:e.shiftKey,ctrl:e.ctrlKey});if(delta){e.preventDefault();parent.scrollLeft+=delta;}};parent.addEventListener('wheel',wheel,{passive:false});return()=>parent.removeEventListener('wheel',wheel);},[]);
  function strokePoints(points:Point[],straight:boolean):InkStroke[]{if(!straight)return [{id:newId(),points}];const lines=new Map<number,{min:number;max:number}>();for(const p of points){const row=Math.max(0,Math.floor(p.y/latest.current.spacing)),v=lines.get(row)??{min:p.x,max:p.x};v.min=Math.min(v.min,p.x);v.max=Math.max(v.max,p.x);lines.set(row,v);}return [...lines].filter(([,v])=>v.max-v.min>=2).map(([r,v])=>({id:newId(),straight:true,points:[{x:v.min,y:(r+.5)*latest.current.spacing},{x:v.max,y:(r+.5)*latest.current.spacing}]}));}
  const map=new Map(props.items.map(i=>[i.id,i]));
  return <div ref={wrapper} className={`paper-document ${props.pencil?'pencil-mode':''}`} style={{minHeight:height}}
    onContextMenu={e=>{if(props.marquee&&marquee.current){e.preventDefault();e.stopPropagation();cancelMarquee();return;}const moving=!!drag.current;if(moving||props.pencil||props.eraser)e.preventDefault();cancelDrag();cancelTextErase();drawing.current=null;setDraft([]);setInk(state.current.ink);if(moving)requestAnimationFrame(focusWriting);}}
    onPointerDownCapture={e=>{if(e.button===0&&!props.disabled&&!props.pencil&&!props.eraser&&!props.marquee)refreshSize();const atom=(e.target as HTMLElement).closest<HTMLElement>('[data-atom]');if(!atom||e.button!==0||props.disabled||props.pencil||props.eraser||props.marquee)return;e.preventDefault();cancelDrag();latest.current.onSelect(map.get(atom.dataset.atom!)!);const box=atom.getBoundingClientRect();
      drag.current={id:atom.dataset.atom!,pointer:e.pointerId,x:e.clientX,y:e.clientY,dx:e.clientX-box.left,dy:e.clientY-box.top,active:false,node:atom};atom.setPointerCapture(e.pointerId);}}
    onPointerMove={e=>{const d=drag.current;if(!d)return;if(!d.active){if(Math.hypot(e.clientX-d.x,e.clientY-d.y)<3)return;d.active=true;d.node.classList.add('drag-source');}e.preventDefault();const r=e.currentTarget.getBoundingClientRect();setDragPreview({id:d.id,x:e.clientX-r.left-d.dx,y:e.clientY-r.top-d.dy});}}
    onPointerUp={e=>{const d=drag.current;if(!d||e.button!==0)return;if(d.active&&!props.disabled){e.preventDefault();dropItem(d.id,e.clientX-d.dx-4,e.clientY-d.dy+latest.current.spacing/2);}cancelDrag();}}
    onPointerCancel={cancelDrag}
    onClick={e=>{const atom=(e.target as HTMLElement).closest<HTMLElement>('[data-atom]');const item=atom&&map.get(atom.dataset.atom!);if(item&&!props.disabled)latest.current.onSelect(item);}}>
    <div ref={root} className="paper-editor" role="textbox" aria-label="整板编辑区" aria-multiline="true" contentEditable={!props.disabled&&!props.pencil&&!props.eraser&&!props.marquee} suppressContentEditableWarning spellCheck={false}
      onInput={input} onBeforeInput={refreshSize} onCompositionStart={()=>{refreshSize();composing.current=true;}} onCompositionEnd={()=>{composing.current=false;input();requestAnimationFrame(()=>resizePaper());}}
      onPaste={e=>{e.preventDefault();if(!props.disabled)replace(e.clipboardData.getData('text/plain').replace(/\r\n?/g,'\n'));}}
      onCopy={e=>{const s=selection();if(!s)return;const rows=readDom(),a=rows.findIndex(r=>r.id===s.anchor.id),b=rows.findIndex(r=>r.id===s.focus.id);if(a<0||b<0)return;const ordered=a<b||(a===b&&s.anchor.offset<=s.focus.offset),first=ordered?s.anchor:s.focus,last=ordered?s.focus:s.anchor;
        const text=rows.slice(Math.min(a,b),Math.max(a,b)+1).map((r,i,arr)=>sliceParts(r.parts,i===0?first.offset:0,i===arr.length-1?last.offset:Infinity).map(p=>'text'in p?p.text:(map.get(p.itemId)?.title??map.get(p.itemId)?.url??'')).join('')).join('\n');e.preventDefault();e.clipboardData.setData('text/plain',text);}}
      onPointerDown={e=>{if(props.disabled||props.pencil||props.eraser||props.marquee||e.button!==0||e.shiftKey||(e.target as HTMLElement).closest('[data-atom]'))return;
        const line=[...root.current!.children].find(n=>{const r=n.getBoundingClientRect();return e.clientY>=r.top&&e.clientY<r.bottom;}) as HTMLElement|undefined;if(!line)return;
        const parts=readParts(line),end=endRect(line);
        if(e.clientY<end.top||e.clientY>end.bottom||e.clientX<end.right+2)return;
        const width=Math.max(0,e.clientX-end.right),columns=Math.max(1,Math.round(width/measure([{text:' '}])));e.preventDefault();
        paintLine(line,compact([...parts,{text:' '.repeat(columns),width}]));root.current!.focus();const p={id:line.dataset.row!,offset:length(parts)+columns};restore({anchor:p,focus:p});}}
      onKeyDown={e=>{
        if(props.disabled||e.nativeEvent.isComposing)return;
        if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();history(e.shiftKey);return;}
        if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='y'){e.preventDefault();history(true);return;}
        if(e.key==='Enter'){e.preventDefault();replace('\n');return;}
        if(e.key==='Tab'){e.preventDefault();replace('    ');return;}
        if(e.key==='Backspace'||e.key==='Delete'){
          const s=selection();if(!s)return;const rows=readDom(),i=rows.findIndex(r=>r.id===s.focus.id);if(i<0)return;
          if(s.anchor.id!==s.focus.id||s.anchor.offset!==s.focus.offset){e.preventDefault();replace('');return;}
          const p=s.focus;
          if(e.key==='Backspace'&&p.offset===0&&i>0){e.preventDefault();replace('',{anchor:{id:rows[i-1].id,offset:length(rows[i-1].parts)},focus:p});}
          else if(e.key==='Delete'&&p.offset===length(rows[i].parts)&&i<rows.length-1){e.preventDefault();replace('',{anchor:p,focus:{id:rows[i+1].id,offset:0}});}
        }
      }}/>
    {hosts.map(({node,id})=>{const item=map.get(id);return item?createPortal(<FileTile item={item} lineHeight={spacing} freeBelow={spacing} locked={props.disabled}/>,node,id):null;})}
    {dragPreview&&map.has(dragPreview.id)&&<div className="paper-file-drag" style={{left:dragPreview.x,top:dragPreview.y}}><FileTile item={map.get(dragPreview.id)!} lineHeight={spacing} freeBelow={spacing} locked={false}/></div>}
    {props.marquee&&!props.disabled&&<div className={`marquee-surface ${groupPreview?'carrying':''}`} aria-label="框选区域"
      onPointerDown={e=>{if(e.button!==0)return;e.preventDefault();const p=groupPoint(e.clientX,e.clientY);marqueeMouse.current={x:e.clientX,y:e.clientY};
        if(marquee.current?.selection){marquee.current.placing=true;marquee.current.pointer=e.pointerId;marquee.current.surface=e.currentTarget;previewGroup(p);}
        else {cancelMarquee();marquee.current={start:p,box:{x:p.x,y:p.y,w:0,h:0},pointer:e.pointerId,surface:e.currentTarget};setMarqueeBox(marquee.current.box);}
        e.currentTarget.setPointerCapture(e.pointerId);}}
      onPointerMove={e=>{const d=marquee.current;if(!d)return;marqueeMouse.current={x:e.clientX,y:e.clientY};const p=groupPoint(e.clientX,e.clientY);if(d.selection){previewGroup(p);return;}d.box={x:Math.min(d.start.x,p.x),y:Math.min(d.start.y,p.y),w:Math.abs(p.x-d.start.x),h:Math.abs(p.y-d.start.y)};setMarqueeBox(d.box);}}
      onPointerUp={e=>{if(e.button!==0)return;const d=marquee.current;if(!d)return;e.preventDefault();if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);
        if(d.selection){if(!d.placing)return;const result=movePaperSelection(d.selection,groupPoint(e.clientX,e.clientY),spacing);d.placing=false;previewGroup(groupPoint(e.clientX,e.clientY));if(!result.valid)return;marquee.current=null;setMarqueeBox(null);setGroupPreview(null);cursor.current=null;commit(result.rows(),null,result.allInk);return;}
        const layout=capturePaperLayout(root.current!,wrapper.current!.getBoundingClientRect(),readDom(),spacing),selected=selectPaper(layout,state.current.ink,d.box,spacing);
        if(!selected){cancelMarquee();return;}d.selection=selected;render(rowsFromCells(layout,selected.rest,spacing),null);setInk(selected.restInk);previewGroup(groupPoint(e.clientX,e.clientY));}}
      onPointerCancel={cancelMarquee}/ >}
    {marqueeBox&&<svg className={`marquee-outline ${groupPreview&&!groupPreview.valid?'blocked':''}`} aria-label="框选虚线框" style={{height:Math.max(height,marqueeBox.y+marqueeBox.h+2)}}><rect x={marqueeBox.x} y={marqueeBox.y} width={marqueeBox.w} height={marqueeBox.h}/></svg>}
    {groupPreview&&<div className="paper-group-ghost" aria-label="框选落点预览" aria-invalid={!groupPreview.valid}>
      {groupPreview.cells.map((cell,i)=><span key={i} className={'itemId'in cell.part?'ghost-atom':'ghost-text'} style={{left:cell.x,top:cell.y}}>{'text'in cell.part?cell.part.text:map.has(cell.part.itemId)?<FileTile item={map.get(cell.part.itemId)!} lineHeight={spacing} freeBelow={spacing} locked={false}/>:null}</span>)}
      <svg className="ink-layer" style={{height:Math.max(height,groupPreview.box.y+groupPreview.box.h)}}>{groupPreview.ink.map(s=><polyline key={s.id} points={s.points.map(p=>`${p.x},${p.y}`).join(' ')} className={s.straight?'ink-line':'ink-free'}/>)}</svg>
      <span className="marquee-hint" style={{left:groupPreview.box.x,top:Math.max(0,groupPreview.box.y-20)}}>{groupPreview.valid?'左键放置 · 右键重新框选':'此处已有内容，请移到空白处'}</span>
    </div>}
    <svg className="ink-layer" aria-label="铅笔画迹" style={{height}}>{[...ink,...draft].map(s=><polyline key={s.id} points={s.points.map(p=>`${p.x},${p.y}`).join(' ')} className={s.straight?'ink-line':'ink-free'}/>)}</svg>
    {(props.pencil||props.eraser)&&!props.disabled&&<div className={`drawing-surface ${props.eraser?'eraser-mode':''} ${props.eraser==='text'?'text-eraser-mode':''}`} aria-label={props.eraser==='text'?'文字橡皮擦区域':props.eraser==='ink'?'铅笔橡皮擦区域':'铅笔绘画区域'} onContextMenu={e=>e.preventDefault()}
      onPointerDown={e=>{if(e.button!==0)return;e.preventDefault();const r=e.currentTarget.getBoundingClientRect(),p={x:e.clientX-r.left,y:e.clientY-r.top};
        if(props.eraser==='text'){cancelTextErase();const session=captureTextEraser(root.current!,r,readDom(),latest.current.spacing);textErasing.current={session,last:p,pointer:e.pointerId,surface:e.currentTarget};e.currentTarget.setPointerCapture(e.pointerId);eraseTextTo(e.clientX,e.clientY);return;}
        const eraser=props.eraser==='ink',workingInk=eraser?eraseInk(state.current.ink,p,p):state.current.ink;drawing.current={points:[p],straight:e.shiftKey,eraser,workingInk};if(eraser)setInk(workingInk);e.currentTarget.setPointerCapture(e.pointerId);}}
      onPointerMove={e=>{if(textErasing.current){eraseTextTo(e.clientX,e.clientY);return;}const d=drawing.current;if(!d)return;const r=e.currentTarget.getBoundingClientRect(),p={x:e.clientX-r.left,y:e.clientY-r.top},last=d.points[d.points.length-1];d.points.push(p);if(d.eraser){d.workingInk=eraseInk(d.workingInk,last,p);setInk(d.workingInk);}else setDraft(strokePoints(d.points,d.straight));}}
      onPointerUp={e=>{if(e.button!==0)return;if(textErasing.current){eraseTextTo(e.clientX,e.clientY);const d=textErasing.current;textErasing.current=null;if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);if(d.session.changed())commit(d.session.result(),cursor.current);return;}
        const d=drawing.current;if(!d)return;const r=e.currentTarget.getBoundingClientRect(),p={x:e.clientX-r.left,y:e.clientY-r.top};if(d.eraser)d.workingInk=eraseInk(d.workingInk,d.points[d.points.length-1],p);d.points.push(p);drawing.current=null;setDraft([]);if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);
        if(d.eraser){if(JSON.stringify(d.workingInk)!==JSON.stringify(state.current.ink))commit(state.current.rows,cursor.current,d.workingInk);return;}
        if(d.points.every(p=>p.x===d.points[0].x&&p.y===d.points[0].y))d.points.push({x:d.points[0].x+.01,y:d.points[0].y});const strokes=strokePoints(d.points,d.straight).filter(s=>s.points.length>1);if(strokes.length)commit(state.current.rows,cursor.current,[...state.current.ink,...strokes]);}}
      onPointerCancel={()=>{cancelTextErase();drawing.current=null;setDraft([]);setInk(state.current.ink);}}/>}
  </div>;
});
