import {expect,it} from 'vitest';
import {eraseInk} from './ink';
import type {InkStroke} from './paper-model';
const line:InkStroke={id:'line',straight:true,points:[{x:0,y:50},{x:100,y:50}]};
it('partial erasure splits a stroke and leaves unaffected strokes unchanged',()=>{
 const far:InkStroke={id:'far',points:[{x:0,y:100},{x:100,y:100}]};const original=structuredClone(line);
 const result=eraseInk([line,far],{x:50,y:50},{x:50,y:50},10);
 expect(result).toHaveLength(3);expect(result[0].points).toEqual([{x:0,y:50},{x:40,y:50}]);expect(result[1].points).toEqual([{x:60,y:50},{x:100,y:50}]);
 expect(result[0].id).toBe('line');expect(result[1].id).not.toBe('line');expect(result[1].straight).toBe(true);expect(result[2]).toBe(far);expect(line).toEqual(original);
});
it('fast eraser movements cover the path between samples even when endpoints miss',()=>{
 const result=eraseInk([line],{x:50,y:0},{x:50,y:100},10);
 expect(result).toHaveLength(2);expect(result[0].points[result[0].points.length-1].x).toBeCloseTo(40);expect(result[1].points[0].x).toBeCloseTo(60);
 expect(eraseInk([line],{x:-20,y:50},{x:120,y:50},10)).toEqual([]);
});
it('erases click dots, preserves missed strokes and can erase remaining fragments',()=>{
 const dot:InkStroke={id:'dot',points:[{x:10,y:10},{x:10.01,y:10}]};expect(eraseInk([dot],{x:10,y:10},{x:10,y:10})).toEqual([]);
 expect(eraseInk([line],{x:0,y:80},{x:100,y:80})[0]).toBe(line);
 const pieces=eraseInk([line],{x:50,y:50},{x:50,y:50});expect(eraseInk(pieces,{x:0,y:50},{x:100,y:50})).toEqual([]);
});
