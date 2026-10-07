import { describe, expect, it } from 'vitest';
import { markdown, moveItem, paperPositions, cutGesture, clipStroke } from './model';
import type { Item } from './model';
const make = (id: string): Item => ({ id, boardId: 'main', type: 'text', text: id, createdAt: '' });
describe('manual ordering', () => {
  it('moves an earlier item before a later item without dropping neighbors', () => {
    const items = [make('a'), make('b'), make('c'), make('d')];
    expect(moveItem(items, 'a', 'c').map(i => i.id)).toEqual(['b', 'a', 'c', 'd']);
    expect(items.map(i => i.id)).toEqual(['a', 'b', 'c', 'd']);
  });
  it('moves to the end and ignores stale drag IDs', () => {
    const items = [make('a'), make('b')];
    expect(moveItem(items, 'a', null).map(i => i.id)).toEqual(['b', 'a']);
    expect(moveItem(items, 'missing', 'b')).toBe(items);
  });
});
it('exports completed and multiline tasks as readable Markdown', () => {
  expect(markdown([{ ...make('a'), text: '第一行\n第二行', done: true }])).toBe('- [x] 第一行\n  第二行\n');
});
it('keeps explicitly positioned notes and lays old notes on compact lines', () => {
  const items = [{ ...make('a'), text: '第一行\n第二行' }, make('b'), { ...make('c'), position: { x: 180, y: 288 } }];
  const positions = paperPositions(items, 500);
  expect(positions.get('a')).toEqual({ x: 24, y: 0 });
  expect(positions.get('b')).toEqual({ x: 24, y: 48 });
  expect(positions.get('c')).toEqual({ x: 180, y: 288 });
});
it('classifies a full stroke after the approach and rejects clicks and diagonal cuts', () => {
  expect(cutGesture([{ x: 400, y: 0 }, { x: 10, y: 240 }, { x: 250, y: 241 }, { x: 490, y: 239 }], 500, 500)).toEqual({ direction: 'horizontal', coordinate: 240 });
  expect(cutGesture([{ x: 250, y: 10 }, { x: 251, y: 250 }, { x: 249, y: 490 }], 500, 500)).toEqual({ direction: 'vertical', coordinate: 250 });
  expect(cutGesture([{ x: 10, y: 10 }], 500, 500)).toBeNull();
  expect(cutGesture([{ x: 10, y: 10 }, { x: 250, y: 250 }, { x: 490, y: 490 }], 500, 500)).toBeNull();
});
it('uses custom line spacing for old notes and cut snapping', () => {
  expect(paperPositions([make('a'), make('b')], 500, 40).get('b')).toEqual({ x: 24, y: 40 });
  expect(cutGesture([{ x: 10, y: 257 }, { x: 490, y: 257 }], 500, 500, 40)).toEqual({ direction: 'horizontal', coordinate: 240 });
});
it('clips a stroke that starts and ends outside the paper, including negative desktop coordinates',()=>{
 const rect={x:-500,y:200,w:400,h:500};
 expect(cutGesture(clipStroke([{x:-550,y:440},{x:-50,y:440}],rect),400,500)).toEqual({direction:'horizontal',coordinate:240});
 expect(clipStroke([{x:-550,y:50},{x:-50,y:50}],rect)).toEqual([]);
});
