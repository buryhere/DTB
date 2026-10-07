import {expect,it} from 'vitest';
import {touchesText} from './text-eraser';
const box={x:20,y:30,w:12,h:16};
it('text eraser hits the entire sweep even when both samples miss the glyph',()=>{
  expect(touchesText({x:0,y:38},{x:100,y:38},box)).toBe(true);
  expect(touchesText({x:26,y:0},{x:26,y:90},box)).toBe(true);
  expect(touchesText({x:0,y:80},{x:100,y:80},box)).toBe(false);
});
it('click erasure respects circular corners and excludes nearby untouched lines',()=>{
  expect(touchesText({x:13,y:23},{x:13,y:23},box)).toBe(true);
  expect(touchesText({x:12,y:22},{x:12,y:22},box)).toBe(false);
  expect(touchesText({x:26,y:60},{x:26,y:60},box)).toBe(false);
});
it('diagonal sweeps test rounded corners and zero radius requires actual intersection',()=>{
  expect(touchesText({x:0,y:20},{x:10,y:10},box)).toBe(false);
  expect(touchesText({x:10,y:20},{x:40,y:50},box,0)).toBe(true);
  expect(touchesText({x:0,y:0},{x:0,y:100},box,0)).toBe(false);
});
