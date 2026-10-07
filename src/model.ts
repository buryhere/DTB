import type {BookmarkStyle} from './bookmark-styles';
import type {PaperRow,InkStroke} from './paper-model';
export type Point = { x: number; y: number };
export type Board = { id: string; bounds: { x: number | null; y: number | null; w: number; h: number }; display: { id: string; scaleFactor: number }; theme: { accent: string; paper?: string; opacity: number }; grid: { lineOpacity: number; spacing?: number; mode: 'underline' }; level: 'desktop' | 'wallpaper' | 'top' | 'bottom'; collision: boolean; autoFade: { enabled: boolean; idleOpacity: number }; collapsed: boolean; edgeHide: boolean; bookmarkStyle?: BookmarkStyle; bookmarkGutter?: number; locked?: boolean; paperRows?: PaperRow[]; ink?: InkStroke[] };
export type Item = { id: string; boardId: string; type: 'text' | 'file' | 'folder' | 'link'; position?: Point; paperRow?: string; text?: string; done?: boolean; path?: string; ext?: string; mode?: 'ref' | 'managed'; title?: string; url?: string; createdAt: string };
export type Settings = { fileMode: 'ref' | 'managed' | null; autostart: boolean; onboardingDone: boolean };
export type Document = { version: 2; boards: Board[]; items: Item[]; archive: Item[]; deletedBoards?: {board:Board;deletedAt:string}[]; settings: Settings };
export function initialDocument(): Document { return { version: 2, boards: [{ id: 'main', bounds: { x: null, y: null, w: 560, h: 660 }, display: { id: '', scaleFactor: 1 }, theme: { accent: '#a67585', paper: '#fff0f5', opacity: .94 }, grid: { lineOpacity: .45, mode: 'underline' }, level: 'desktop', collision: true, autoFade: { enabled: true, idleOpacity: .30 }, collapsed: false, edgeHide: false }], items: [], archive: [], settings: { fileMode: null, autostart: false, onboardingDone: false } }; }

export const LINE_HEIGHT = 24;
// Clip every segment, including a fast stroke whose two events both lie outside
// the paper. Coordinates returned to the gesture classifier are paper-relative.
export function clipStroke(points:Point[], rect:Point & {w:number;h:number}):Point[] {
  const result:Point[]=[];
  for(let i=1;i<points.length;i++) {
    const a=points[i-1],b=points[i],dx=b.x-a.x,dy=b.y-a.y;let lo=0,hi=1,valid=true;
    const p=[-dx,dx,-dy,dy],q=[a.x-rect.x,rect.x+rect.w-a.x,a.y-rect.y,rect.y+rect.h-a.y];
    for(let j=0;j<4;j++){if(p[j]===0){if(q[j]<0)valid=false;}else {const t=q[j]/p[j];if(p[j]<0)lo=Math.max(lo,t);else hi=Math.min(hi,t);}}
    if(valid&&lo<=hi){result.push({x:a.x+dx*lo-rect.x,y:a.y+dy*lo-rect.y},{x:a.x+dx*hi-rect.x,y:a.y+dy*hi-rect.y});}
  }
  return result;
}
// Coordinates are CSS pixels relative to the unscrolled paper, independent of DPI.
export function paperPositions(items: Item[], width: number, lineHeight = LINE_HEIGHT): Map<string, Point> {
  const result = new Map<string, Point>(); let nextY = 0;
  for (const item of items) {
    const p = item.position ?? { x: 24, y: nextY };
    result.set(item.id, p);
    const columns = Math.max(1, Math.floor((width - p.x - 24) / 13));
    const lines = item.type === 'text' ? (item.text ?? '').split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(Array.from(line).length / columns)), 0) : 1;
    nextY = Math.max(nextY, p.y + lines * lineHeight);
  }
  return result;
}

export function cutGesture(points: Point[], width: number, height: number, lineHeight = LINE_HEIGHT): { direction: 'horizontal' | 'vertical'; coordinate: number } | null {
  if (points.length < 2) return null;
  const last = points[points.length - 1];
  // Ignore the approach from the toolbar; classify the final straight stroke.
  const tail = (axis: 'x' | 'y') => {
    let start = points.length - 1;
    while (start > 0 && Math.abs(points[start - 1][axis] - last[axis]) <= 24) start--;
    return points.slice(start);
  };
  const horizontal = tail('y'), vertical = tail('x');
  const hFirst = horizontal[0], vFirst = vertical[0];
  if (Math.abs(last.x - hFirst.x) >= width * .55 && Math.abs(last.y - hFirst.y) <= Math.abs(last.x - hFirst.x) * .35) {
    const y = horizontal.reduce((n, p) => n + p.y, 0) / horizontal.length;
    return { direction: 'horizontal', coordinate: Math.round(y / lineHeight) * lineHeight };
  }
  if (Math.abs(last.y - vFirst.y) >= height * .55 && Math.abs(last.x - vFirst.x) <= Math.abs(last.y - vFirst.y) * .35) {
    const x = vertical.reduce((n, p) => n + p.x, 0) / vertical.length;
    return { direction: 'vertical', coordinate: Math.round(x) };
  }
  return null;
}
export const newId = () => crypto.randomUUID();
export function moveItem(items: Item[], moving: string, before: string | null): Item[] {
  const item = items.find(i => i.id === moving); if (!item || moving === before) return items;
  const rest = items.filter(i => i.id !== moving), index = before === null ? rest.length : rest.findIndex(i => i.id === before);
  rest.splice(index < 0 ? rest.length : index, 0, item); return rest;
}
export function markdown(items: Item[]): string { return items.map(i => i.type === 'text' ? `- [${i.done ? 'x' : ' '}] ${(i.text ?? '').replace(/\n/g, '\n  ')}` : `- [${i.title ?? i.path ?? i.url}](${i.url ?? i.path})`).join('\n') + '\n'; }
