import {newId,paperPositions} from './model';
import type {Item} from './model';
import {filePresentation} from './file-presentation';
export type PaperPart={text:string;width?:number}|{itemId:string};
export type PaperRow={id:string;parts:PaperPart[];height:number;wrapWidth?:number};
export type InkStroke={id:string;points:{x:number;y:number}[];straight?:boolean};
export const CHAR_WIDTH=7.2;
export const fontScale=(spacing:number)=>spacing/24;
export const emptyRow=():PaperRow=>({id:newId(),parts:[],height:1});
export const blank=(row:PaperRow)=>row.parts.every(p=>'text'in p&&!p.text.trim());
export const length=(parts:PaperPart[])=>parts.reduce((n,p)=>n+('text'in p?p.text.length:1),0);
export function compact(parts:PaperPart[]):PaperPart[]{const result:PaperPart[]=[];for(const p of parts){if('text'in p){if(!p.text)continue;const last=result[result.length-1];if(last&&'text'in last&&(last.width===undefined)===(p.width===undefined)&&(p.width===undefined||Math.abs((last.width??0)/last.text.length-p.width/p.text.length)<.001)){last.text+=p.text;if(p.width!==undefined)last.width=(last.width??0)+p.width;}else result.push({...p});}else result.push({...p});}return result;}
export function sliceParts(parts:PaperPart[],start:number,end=Infinity):PaperPart[]{let offset=0;return compact(parts.flatMap<PaperPart>(p=>{const n='text'in p?p.text.length:1;const a=Math.max(0,start-offset),b=Math.min(n,end-offset);offset+=n;return b<=a?[]:'text'in p?[{text:p.text.slice(a,b),...(p.width===undefined?{}:{width:p.width*(b-a)/n})}]:[{...p}];}));}
const units=(parts:PaperPart[])=>parts.flatMap<PaperPart>(p=>'text'in p?p.text.split('').map(text=>({text,...(p.width===undefined?{}:{width:p.width/p.text.length})})):[{...p}]);
const same=(a:PaperPart,b:PaperPart)=>'text'in a&&'text'in b?a.text===b.text:'itemId'in a&&'itemId'in b&&a.itemId===b.itemId;
const space=(p:PaperPart)=>'text'in p&&p.text===' ';
// Preserve unchanged content after a whitespace buffer in the same logical row.
// A fractional gap width keeps Chinese and Latin input from accumulating drift.
export function preserveInlineBuffers(before:PaperPart[],after:PaperPart[],measure:(parts:PaperPart[])=>number,caret:number){
  const a=units(before),b=units(after);let prefix=0;while(prefix<a.length&&prefix<b.length&&same(a[prefix],b[prefix]))prefix++;
  let oldEnd=a.length,newEnd=b.length;while(oldEnd>prefix&&newEnd>prefix&&same(a[oldEnd-1],b[newEnd-1])){oldEnd--;newEnd--;}
  if(oldEnd===prefix&&newEnd===prefix)return {parts:after,caret};
  let shift=0;
  const width=(parts:PaperPart[])=>measure(compact(parts));const spaceWidth=width([{text:' '}]);
  for(let start=0;start<a.length;){if(!space(a[start])){start++;continue;}let end=start;while(end<a.length&&space(a[end]))end++;
    if(end>=oldEnd&&end<a.length&&(end-start>=2||start===0)){
      const anchor=newEnd+end-oldEnd+shift;let gapStart=anchor;while(gapStart>newEnd&&space(b[gapStart-1]))gapStart--;
      const available=width(b.slice(gapStart,anchor)),difference=width(b.slice(0,anchor))-width(a.slice(0,end));
      const nextWidth=Math.max(0,available-difference);
      if(Math.abs(nextWidth-available)>.01){const count=nextWidth>.01?Math.max(1,Math.round(nextWidth/spaceWidth)):0;
        const added:PaperPart[]=count?units([{text:' '.repeat(count),width:nextWidth}]):[];
        const removed=anchor-gapStart;b.splice(gapStart,removed,...added);shift+=count-removed;
        if(caret>gapStart)caret=caret>=anchor?caret+count-removed:gapStart+Math.min(count,caret-gapStart);
      }
    }start=end;
  }
  return {parts:compact(b),caret};
}
export function rowStarts(rows:PaperRow[]):Map<string,number>{let y=0;return new Map(rows.map(r=>{const p:[string,number]=[r.id,y];y+=r.height;return p;}));}
// Only unchanged content below the edit is anchored. Consume old empty lines
// before moving an anchor; shrinking earlier content replenishes those lines.
export function preserveBuffers(before:PaperRow[],after:PaperRow[],caretId?:string):PaperRow[]{
  const result=after.map(r=>({...r,parts:compact(r.parts)})),positions=rowStarts(before),old=new Map(before.map(r=>[r.id,r]));let boundary=0;
  for(let index=0;index<result.length;index++){
    const row=result[index],previous=old.get(row.id);
    if(!previous||blank(row)||JSON.stringify(row.parts)!==JSON.stringify(previous.parts))continue;
    let actual=result.slice(0,index).reduce((n,r)=>n+r.height,0),desired=positions.get(row.id)!;
    for(let j=index-1;actual>desired&&j>=boundary;j--){const r=result[j];if(blank(r)&&old.has(r.id)&&r.id!==caretId){result.splice(j,1);index--;actual-=r.height;}}
    while(actual<desired){result.splice(index,0,emptyRow());index++;actual++;}
    boundary=index+1;
  }
  return result;
}
export function migrateRows(items:Item[],width:number,spacing:number):PaperRow[]{
  const positions=paperPositions(items,width,spacing),rows:PaperRow[]=[];
  const sorted=[...items].sort((a,b)=>(positions.get(a.id)!.y-positions.get(b.id)!.y)||(positions.get(a.id)!.x-positions.get(b.id)!.x));
  for(const item of sorted){const p=positions.get(item.id)!;let index=Math.max(0,Math.round(p.y/spacing));const lines=item.type==='text'?(item.text??'').split('\n'):[''];
    let lineIndex=0;for(const text of lines){while(rows.length<=index)rows.push(emptyRow());let row=rows[index];
      if(blank(row))row.id=lineIndex===0?(item.paperRow??(item.type==='text'?item.id:'row-'+item.id)):newId();lineIndex++;
      const used=row.parts.reduce((n,q)=>n+('text'in q?(q.width??Array.from(q.text).reduce((v,c)=>v+(c.charCodeAt(0)>255?13:CHAR_WIDTH)*fontScale(spacing),0)):filePresentation(items.find(i=>i.id===q.itemId)!,spacing).width),0);
      const pad=Math.max(0,p.x-24-used);if(pad>.01)row.parts.push({text:' '.repeat(Math.max(1,Math.round(pad/(CHAR_WIDTH*fontScale(spacing))))),width:pad});
      row.parts.push(item.type==='text'?{text}: {itemId:item.id});row.parts=compact(row.parts);index++;
    }
  }
  return rows;
}
export function mirrorItems(rows:PaperRow[],source:Item[],boardId:string,spacing:number):Item[]{
  const previous=new Map(source.map(i=>[i.id,i])),result:Item[]=[];let y=0;
  for(const row of rows){let x=24,textIndex=0;for(const part of row.parts){
    if('text'in part){const id=textIndex===0?row.id:`${row.id}-t${textIndex+1}`;
      const indent=part.text.match(/^ */)?.[0].length??0;
      if(part.text.trim()){textIndex++;result.push({id,boardId,type:'text',text:part.text.slice(indent),position:{x:x+indent*CHAR_WIDTH*fontScale(spacing),y},paperRow:row.id,createdAt:previous.get(id)?.createdAt??new Date().toISOString()});}
      x+=part.width??Array.from(part.text).reduce((n,c)=>n+(c.charCodeAt(0)>255?13:CHAR_WIDTH)*fontScale(spacing),0);
    }else{const item=previous.get(part.itemId);if(item){result.push({...item,boardId,paperRow:row.id,position:{x,y}});x+=filePresentation(item,spacing).width;}}
  }y+=row.height*spacing;}
  return result;
}
export function paperMarkdown(rows:PaperRow[],items:Item[]):string{const map=new Map(items.map(i=>[i.id,i]));return rows.map(r=>r.parts.map(p=>{if('text'in p)return p.text;const i=map.get(p.itemId);return i?`[${i.title??i.url??'文件'}](${i.url??i.path??''})`:'';}).join('')).join('\n').trimEnd()+'\n';}
