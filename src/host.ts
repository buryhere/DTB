import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow, currentMonitor, availableMonitors, PhysicalPosition, PhysicalSize } from '@tauri-apps/api/window';
import { initialDocument } from './model';
import type { Board, Document, Item, Settings } from './model';
import { bookmarkMetrics } from './bookmark-styles';
export const native = isTauri();
export const windowId = () => native ? getCurrentWindow().label : 'main';
export async function loadDocument(): Promise<Document> { if (native) return invoke('load_document'); const saved = localStorage.getItem('desktop-board-preview'); return saved ? JSON.parse(saved) : initialDocument(); }
export async function saveBoard(board: Board, items: Item[], settings: Settings): Promise<void> {
  if (native) return invoke('save_board', { board, items, settings, origin: windowId() });
  const doc = await loadDocument(); doc.boards = doc.boards.map(b => b.id === board.id ? board : b); doc.items = [...doc.items.filter(i => i.boardId !== board.id), ...items]; doc.settings = settings; localStorage.setItem('desktop-board-preview', JSON.stringify(doc));
}
export async function importPaths(paths: string[], mode: 'ref' | 'managed'): Promise<Omit<Item, 'id' | 'boardId' | 'createdAt'>[]> { return invoke('import_paths', { paths, mode }); }
export async function openItem(item: Item): Promise<void> { if (native) return invoke('open_item', { id: item.id }); if (item.url) window.open(item.url, '_blank', 'noopener,noreferrer'); }
export async function setAutostart(enabled: boolean) { if (native) await invoke('set_autostart', { enabled }); }
export async function applyLevel(level: Board['level']) { if (native) await invoke('set_level', { label: windowId(), level }); }
export async function nudge(dx: number, dy: number) { if (!native) return; const win = getCurrentWindow(), point = await win.outerPosition(); await win.setPosition(new PhysicalPosition(point.x + dx, point.y + dy)); }
export async function fitBoard(centerOnly: boolean) { if (native) await invoke('fit_board', { label: windowId(), centerOnly }); }
export async function restoreWindow(board: Board) {
  if (!native) return; const win = getCurrentWindow(), fresh = !board.display.id;
  const scale = fresh ? await win.scaleFactor() : board.display.scaleFactor || 1;
  const layout=bookmarkMetrics(board.bookmarkStyle),oldGutter=board.bookmarkGutter??28;
  const delta=Math.round((8+layout.gutter)*scale)-Math.round((8+oldGutter)*scale);
  await win.setMinSize(new PhysicalSize(Math.round((240+layout.gutter-28)*scale),Math.round(180*scale)));
  await win.setSize(new PhysicalSize(Math.round(Math.max((240+layout.gutter-28) * scale, board.bounds.w * (fresh ? scale : 1)+delta)), Math.round(Math.max(180 * scale, board.bounds.h * (fresh ? scale : 1)))));
  if (board.bounds.x !== null && board.bounds.y !== null) await win.setPosition(new PhysicalPosition(Math.round(board.bounds.x)-delta, Math.round(board.bounds.y)));
  else await win.center();
  const monitors = await availableMonitors(), point = await win.outerPosition();
  if (!monitors.some(m => point.x + 80 > m.position.x && point.y + 40 > m.position.y && point.x < m.position.x + m.size.width && point.y < m.position.y + m.size.height)) await win.center();
  if (board.collapsed) await invoke('set_collapsed', { label: windowId(), collapsed: true, expandedHeight: board.bounds.h });
  await win.setResizable(!board.locked);
  // Install native transparency/hit testing before first showing this board.
  // Its document transaction has completed by the time restoreWindow runs.
  await invoke('edge_hide_activity', { label: windowId(), enabled: !!board.edgeHide, blocked: true, style:board.bookmarkStyle??'heart' });
  await applyLevel(board.level); await win.show();
}
export async function getGeometry(): Promise<Pick<Board, 'bounds' | 'display'>> {
  const win = getCurrentWindow(), [position, size, monitors] = await Promise.all([invoke<{x:number;y:number}>('expanded_board_position',{label:windowId()}), win.outerSize(), availableMonitors()]);
  const overlap=(m:typeof monitors[number])=>Math.max(0,Math.min(position.x+size.width,m.position.x+m.size.width)-Math.max(position.x,m.position.x))*Math.max(0,Math.min(position.y+size.height,m.position.y+m.size.height)-Math.max(position.y,m.position.y));
  const monitor=monitors.sort((a,b)=>overlap(b)-overlap(a))[0]??await currentMonitor();
  return { bounds: { x: position.x, y: position.y, w: size.width, h: size.height }, display: { id: monitor?.name ?? '', scaleFactor: monitor?.scaleFactor ?? 1 } };
}

export async function resizeWithRatio(target: HTMLElement, pointerId: number, direction: string, startX: number, startY: number) {
  if (!native) return;
  target.setPointerCapture(pointerId);
  const win = getCurrentWindow(), [position, size, scale] = await Promise.all([win.outerPosition(), win.outerSize(), win.scaleFactor()]);
  const ratio = size.width / size.height;
  let pending: { x: number; y: number } | null = null, busy = false, finished = false;
  const apply = async () => {
    if (busy || !pending) return; busy = true;
    const point = pending; pending = null;
    const dx = (point.x - startX) * scale * (direction.includes('West') ? -1 : 1);
    const dy = (point.y - startY) * scale * (direction.includes('North') ? -1 : 1);
    const delta = Math.abs(dx) > Math.abs(dy * ratio) ? dx : dy * ratio;
    const width = Math.max(240 * scale, 180 * scale * ratio, size.width + delta), height = width / ratio;
    try { await win.setSize(new PhysicalSize(Math.round(width), Math.round(height))); if (direction.includes('West') || direction.includes('North')) await win.setPosition(new PhysicalPosition(direction.includes('West') ? position.x + size.width - Math.round(width) : position.x, direction.includes('North') ? position.y + size.height - Math.round(height) : position.y)); }
    finally { busy = false; if (pending && !finished) requestAnimationFrame(() => { apply().catch(console.error); }); }
  };
  const move = (event: PointerEvent) => { pending = { x: event.screenX, y: event.screenY }; requestAnimationFrame(() => { apply().catch(console.error); }); };
  const end = () => { finished = true; target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', end); target.removeEventListener('pointercancel', end); if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId); };
  target.addEventListener('pointermove', move); target.addEventListener('pointerup', end); target.addEventListener('pointercancel', end);
}
