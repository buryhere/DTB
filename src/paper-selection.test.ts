import {describe,expect,it} from 'vitest';
import {fitPaperRows,freezePaperLayout,movePaperSelection,rowsFromCells,selectPaper} from './paper-selection';
import type {PaperCell,PaperLayout} from './paper-selection';
import type {PaperRow} from './paper-model';
const row=(id:string,text=''):PaperRow=>({id,parts:text?[{text}]:[],height:1});
const cell=(text:string,x:number,y=0):PaperCell=>({part:{text},x,y,width:12});
const layout=(cells:PaperCell[]):PaperLayout=>({rows:Array.from({length:8},(_,i)=>row(`r${i}`)),cells,left:24,right:500});
describe('group selection',()=>{
 it('moves graphemes, atoms and whole intersecting ink together without changing unselected cells',()=>{
  const cells=[cell('中',24),cell('😀',36),{part:{itemId:'file'},x:24,y:24,width:40},cell('later',300,72)];
  const ink=[{id:'ink',points:[{x:30,y:40},{x:90,y:40}]},{id:'other',points:[{x:200,y:150}]}];
  const selected=selectPaper(layout(cells),ink,{x:23,y:0,w:80,h:48},24)!;expect(selected.cells).toHaveLength(3);expect(selected.ink).toHaveLength(1);
  const moved=movePaperSelection(selected,{x:240,y:132},24);expect(moved.valid).toBe(true);expect(moved.box.x+moved.box.w/2).toBe(240);
  const dx=moved.cells[0].x-cells[0].x,dy=moved.cells[0].y-cells[0].y;expect(dy%24).toBe(0);expect(moved.ink[0].points[0]).toEqual({x:30+dx,y:40+dy});
  expect(selected.rest.find(c=>'text'in c.part&&c.part.text==='later')).toEqual(cells[3]);
  const rows=moved.rows();expect(rows.flatMap(r=>r.parts).filter(p=>'itemId'in p)).toEqual([{itemId:'file'}]);
  expect(rows.flatMap(r=>r.parts).filter(p=>'text'in p&&p.text.includes('😀'))).toHaveLength(1);
 });
 it('rejects occupied destinations without changing the captured source',()=>{
  const cells=[cell('a',24),cell('b',100,24)],original=structuredClone(cells),selected=selectPaper(layout(cells),[],{x:24,y:0,w:12,h:24},24)!;
  const blocked=movePaperSelection(selected,{x:106,y:36},24);expect(blocked.valid).toBe(false);expect(cells).toEqual(original);
 });
 it('does not carry empty whitespace and never splits an emoji',()=>{
  expect(selectPaper(layout([cell(' ',24)]),[],{x:20,y:0,w:50,h:24},24)).toBeNull();
  const selected=selectPaper(layout([cell('😀',24)]),[],{x:29,y:3,w:1,h:5},24)!;
  expect(selected.cells[0].part).toEqual({text:'😀'});expect(selected.box).toEqual({x:24,y:0,w:12,h:24});
 });
 it('projects sparse rows with precise gaps rather than inserting extra text',()=>{
  const rows=rowsFromCells(layout([cell('a',100),cell('b',300,48)]),[cell('a',100),cell('b',300,48)],24);
  expect(rows[0].parts).toEqual([{text:' ',width:76},{text:'a'}]);expect(rows[2].parts).toEqual([{text:' ',width:276},{text:'b'}]);
 });
});
describe('paper extent',()=>{
 it('trims only the empty tail and keeps interior buffers and the viewport',()=>{
  const rows=Array.from({length:100},(_,i)=>row(`r${i}`,i===3?'note':''));rows[3].parts.push({text:' ',width:200});
  const next=fitPaperRows(rows,[],10,24);expect(next).toHaveLength(10);expect(next[3].parts).toEqual([{text:'note'}]);expect(next[0].id).toBe('r0');
 });
 it('ink and an active writing caret reserve their rows',()=>{
  const rows=Array.from({length:100},(_,i)=>row(`r${i}`));rows[30].parts=[{text:' ',width:150}];
  expect(fitPaperRows(rows,[{id:'ink',points:[{x:50,y:1000}]}],10,24)).toHaveLength(42);
  const next=fitPaperRows(rows,[],10,24,'r30');expect(next).toHaveLength(31);expect(next[30].parts).toEqual(rows[30].parts);
  expect(fitPaperRows(rows,[],10,24)).toHaveLength(10);
 });
});
describe('frozen visual rows',()=>{
 it('keeps visual positions and maps caret/selection offsets across wrapped text, gaps and atoms',()=>{
  const cells:PaperCell[]=[{part:{text:'abc'},x:24,y:0,width:21,source:{id:'paragraph',offset:0}},
   {part:{text:'   ',width:30},x:45,y:0,width:30,source:{id:'paragraph',offset:3}},
   {part:{itemId:'file'},x:75,y:0,width:40,source:{id:'paragraph',offset:6}},
   {part:{text:'😀'},x:24,y:24,width:26,source:{id:'paragraph',offset:7}},
   {part:{text:'W'},x:50,y:24,width:7,source:{id:'paragraph',offset:9}}];
  const captured=layout(cells);captured.sourceRows=[{id:'paragraph',y:0},{id:'blank',y:48}];
  const frozen=freezePaperLayout(captured,24);expect(frozen.rows[0].parts).toEqual([{text:'abc'},{text:'   ',width:30},{itemId:'file'}]);expect(frozen.rows[1].parts).toEqual([{text:'😀W'}]);
  expect(frozen.remap({id:'paragraph',offset:5})).toEqual({id:'r0',offset:5});expect(frozen.remap({id:'paragraph',offset:7})).toEqual({id:'r1',offset:0});expect(frozen.remap({id:'paragraph',offset:10})).toEqual({id:'r1',offset:3});expect(frozen.remap({id:'blank',offset:0})).toEqual({id:'r2',offset:0});expect(frozen.width).toBe(128);
 });
});
