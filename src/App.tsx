import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Ellipsis, Eraser, Grip, LockKeyhole, UnlockKeyhole, Minus, Plus, Pencil, Scissors, Settings2, Trash2, Undo2, X, Download, FileText, Scan } from 'lucide-react';
import { initialDocument, newId, LINE_HEIGHT } from './model';
import type { Board, Document, Item } from './model';
import * as host from './host';
import { CutSurface } from './cut-overlay';
import type { CutScene } from './cut-overlay';
import { Preview } from './preview';
import { Bookmark } from './bookmark';
import { BookmarkPicker } from './bookmark-picker';
import { bookmarkMetrics } from './bookmark-styles';
import { Bookmark as BookmarkIcon } from 'lucide-react';
import { PaperEditor } from './paper-editor';
import type {PaperEditorHandle} from './paper-editor';
import {paperMarkdown} from './paper-model';
import type {PaperRow,InkStroke} from './paper-model';
import type {EraserMode} from './text-eraser';
import './App.css';

const edges = ['North', 'South', 'East', 'West', 'NorthEast', 'NorthWest', 'SouthEast', 'SouthWest'] as const;
const colors = ['#63866b', '#7188a5', '#ab8869', '#a67585', '#777587'];
export default function App() {
  const [doc, setDoc] = useState<Document>(initialDocument);
  const boardId = host.windowId().replace(/^board-/, '');
  const board = doc.boards.find(b => b.id === boardId) ?? initialDocument().boards[0];
  const items = doc.items.filter(i => i.boardId === board.id);
  const lineHeight = board.grid.spacing ?? LINE_HEIGHT, locked = board.locked ?? false;
  const saveKey = JSON.stringify({ board, items, settings: doc.settings });
  const [ready, setReady] = useState(false), [status, setStatus] = useState('准备中');
  const [error, setError] = useState(''), [selected, setSelected] = useState<string | null>(null);
  const [pencil,setPencil]=useState(false),[eraser,setEraser]=useState<EraserMode>(null),[marquee,setMarquee]=useState(false),[tools,setTools]=useState(false),[canUndo,setCanUndo]=useState(false);
  const editorRef=useRef<PaperEditorHandle>(null);
  const [menu, setMenu] = useState(false), [settingsOpen, setSettingsOpen] = useState(false);
  const [bookmarkOpen,setBookmarkOpen]=useState(false);
  const [preview, setPreview] = useState<Item | null>(null), [hover, setHover] = useState(true);
  const [dropping, setDropping] = useState(false), [pendingPaths, setPendingPaths] = useState<string[] | null>(null);
  const [cut, setCut] = useState(false), [cutPreview,setCutPreview] = useState<CutScene|null>(null);
  const [boardDialog,setBoardDialog] = useState<'merge'|'delete'|'restore'|null>(null), [busy,setBusy] = useState(false);
  const [edgeState,setEdgeState]=useState<{hidden:boolean;edge:'left'|'right'|'top'|'bottom'|null}>({hidden:false,edge:null});
  const frozen = useRef(false), operationToken = useRef<string|null>(null);
  const paper = useRef<HTMLElement>(null), boardElement = useRef<HTMLElement>(null);
  const latest = useRef({ doc, board, items }); latest.current = { doc, board, items };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fail = useCallback((e: unknown) => setError(String(e)), []);
  const flush = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (!latest.current.doc.boards.some(b=>b.id===boardId)) return;
    const current = latest.current; setStatus('保存中');
    const snapshot=editorRef.current?.flush();
    const rect=paper.current?.getBoundingClientRect();
    const savedBoard={...(snapshot?{...current.board,paperRows:snapshot.rows,ink:snapshot.ink}:current.board),...(rect?{paperLayout:{x:rect.x,y:rect.y,w:rect.width,h:rect.height}}:{})};
    await host.saveBoard(savedBoard,snapshot?.items??current.items,current.doc.settings); setStatus('已保存');
  }, []);
  const patchBoard = useCallback((patch: Partial<Board>) => {
    if (frozen.current) return;
    latest.current = { ...latest.current, board: { ...latest.current.board, ...patch } };
    setDoc(d => ({ ...d, boards: d.boards.map(b => b.id === latest.current.board.id ? { ...b, ...patch } : b) }));
  }, []);
  const onPaper=useCallback((rows:PaperRow[],ink:InkStroke[],items:Item[])=>{
    if(frozen.current)return;
    const b={...latest.current.board,paperRows:rows,ink};latest.current={...latest.current,board:b,items};
    setDoc(d=>({...d,boards:d.boards.map(board=>board.id===b.id?b:board),items:[...d.items.filter(i=>i.boardId!==b.id),...items]}));
  },[]);
  async function toggleLock() {
    setBookmarkOpen(false);
    setPencil(false);setEraser(null);setMarquee(false);setTools(false); setMenu(false); setSettingsOpen(false); setPreview(null); setPendingPaths(null); setDropping(false); setSelected(null);
    try {
      await flush();
      const enabled = !latest.current.board.locked;
      if (host.native) await invoke('set_board_lock', { label: host.windowId(), enabled });
      patchBoard({ locked: enabled });
      await flush();
    } catch (err) { fail(err); }
  }
  function writeMode(){setPencil(false);setEraser(null);setMarquee(false);setTools(false);requestAnimationFrame(()=>editorRef.current?.focusWriting());}
  async function patchBookmark(patch:Partial<Board>) {
    if(!patch.bookmarkStyle||!host.native||patch.bookmarkStyle===latest.current.board.bookmarkStyle){patchBoard({...patch,...(patch.bookmarkStyle?{bookmarkGutter:bookmarkMetrics(patch.bookmarkStyle).gutter}:{})});return;}
    if(frozen.current)return;
    setBusy(true);
    try {
      await flush();frozen.current=true;
      const bounds=await invoke<Board['bounds']>('set_bookmark_style',{label:host.windowId(),style:patch.bookmarkStyle});
      frozen.current=false;patchBoard({...patch,bounds,bookmarkGutter:bookmarkMetrics(patch.bookmarkStyle).gutter});
      await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
      await flush();
    }catch(err){fail(err);}finally{frozen.current=false;setBusy(false);}
  }
  async function toggleBookmark() {
    if (locked || busy || cut) return;
    try {
      await flush();
      const enabled = !latest.current.board.edgeHide;
      setBookmarkOpen(false);
      setPencil(false);setEraser(null);setMarquee(false);setTools(false);setMenu(false);setSettingsOpen(false);setPreview(null);setBoardDialog(null);setPendingPaths(null);setDropping(false);
      if (host.native) await invoke('set_edge_hide', { label: host.windowId(), enabled });
      patchBoard({ edgeHide: enabled });
      await flush();
    } catch (err) { fail(err); }
  }
  function setLineSpacing(value:number) {
    const spacing=Math.max(16,Math.min(64,Math.round(value))),old=latest.current.board.grid.spacing??LINE_HEIGHT;
    patchBoard({grid:{...latest.current.board.grid,spacing},ink:(latest.current.board.ink??[]).map(s=>({...s,points:s.points.map(p=>({...p,y:p.y/old*spacing}))}))});
  }
  const receivePaths = useCallback(async (paths: string[], mode: 'ref' | 'managed') => {
    if (latest.current.board.locked) return;
    try {
      const imported = await host.importPaths(paths, mode);
      if (latest.current.board.locked) return;
      editorRef.current?.insertItems(imported.map(i=>({...i,id:newId(),boardId:latest.current.board.id,createdAt:new Date().toISOString()})));
      setDoc(d => ({ ...d, settings: { ...d.settings, fileMode: mode } })); setPendingPaths(null);
    } catch (e) { fail(e); }
  }, [fail]);
  async function beginCut() {
    if (locked || board.collapsed || !paper.current || !boardElement.current) return;
    setPencil(false);setEraser(null);setMarquee(false);setTools(false);setMenu(false);setSelected(null);
    try {
      await flush();
      const area=paper.current.getBoundingClientRect(),rect=boardElement.current.getBoundingClientRect();
      if(host.native) await invoke('start_cut',{label:host.windowId(),paper:{x:area.left,y:area.top,w:area.width,h:area.height},scrollTop:paper.current.scrollTop});
      else {setCut(true);setCutPreview({token:'preview',label:'main',origin:{x:0,y:0},scale:1,lineHeight,paper:{x:area.left,y:area.top,w:area.width,h:area.height},board:{x:rect.left,y:rect.top,w:rect.width,h:rect.height}});}
    } catch(err) {fail(err);}
  }
  async function operate(action:string,sourceId?:string) {
    setBoardDialog(null);setMenu(false);
    try {await invoke('board_operation',{label:host.windowId(),action,sourceId:sourceId??null});}
    catch(err){fail(err);}
  }
  useEffect(() => {
    let active = true;
    host.loadDocument().then(async d => {
      if (!active) return; setDoc(d);
      let b = d.boards.find(b => b.id === boardId);
      if(!b){setReady(true);return;}
      // Old header-only folding is replaced by the bookmark's explicit mode.
      if(b.collapsed){b={...b,collapsed:false};d={...d,boards:d.boards.map(row=>row.id===b!.id?b!:row)};setDoc(d);}
      latest.current = { doc: d, board: b, items: d.items.filter(i => i.boardId === b.id) };
      await host.restoreWindow(b);
      if (active) { if (host.native) { const geometry = await host.getGeometry(); if (b.collapsed) geometry.bounds.h = b.bounds.h; const restored = { ...b, ...geometry, bookmarkGutter:bookmarkMetrics(b.bookmarkStyle).gutter }; latest.current = { ...latest.current, board: restored }; setDoc({ ...d, boards: d.boards.map(board => board.id === boardId ? restored : board) }); } setReady(true); setStatus('已保存'); }
    }).catch(fail); return () => { active = false; };
  }, [boardId, fail]);
  useEffect(() => { if (!ready || frozen.current || !doc.boards.some(b=>b.id===boardId)) return; setStatus('待保存'); timer.current = setTimeout(() => flush().catch(fail), 500); return () => { if (timer.current) clearTimeout(timer.current); }; }, [saveKey,ready,flush,fail]);
  useEffect(() => {
    if (!host.native || !ready) return;
    const win = getCurrentWindow(); let stopped = false, geometryTimer: ReturnType<typeof setTimeout> | null = null;
    const disposers: (() => void)[] = [], bind = (p: Promise<() => void>) => p.then(fn => stopped ? fn() : disposers.push(fn)).catch(fail);
    const geometry = () => { if (geometryTimer) clearTimeout(geometryTimer); geometryTimer = setTimeout(() => host.getGeometry().then(g => { if (latest.current.board.collapsed) g.bounds.h = latest.current.board.bounds.h; patchBoard(g); }).catch(fail), 150); };
    bind(win.onMoved(geometry)); bind(win.onResized(geometry));
    bind(win.onCloseRequested(async e => { e.preventDefault(); if (latest.current.board.locked) return; try { await flush(); await win.hide(); } catch (err) { fail(err); } }));
    bind(listen('flush-before-quit', () => { flush().then(() => invoke('quit_flushed', { label: host.windowId() })).catch(fail); }).then(async unlisten => { await invoke('frontend_ready', { label: host.windowId() }); return unlisten; }));
    bind(win.onDragDropEvent(e => { if (latest.current.board.locked) return; const p = e.payload; setDropping(p.type === 'enter' || p.type === 'over'); if (p.type === 'drop') { const mode = latest.current.doc.settings.fileMode; if (mode) receivePaths(p.paths, mode); else setPendingPaths(p.paths); } }));
    bind(listen<boolean>('cut-armed',e=>setCut(e.payload)));
    bind(listen<string>('cut-error',e=>fail(e.payload)));
    bind(listen<{token:string}>('board-operation-flush',e=>{
      operationToken.current=e.payload.token;frozen.current=true;setBusy(true);
      flush().then(()=>invoke('board_operation_flushed',{token:e.payload.token,label:host.windowId(),error:null})).catch(err=>invoke('board_operation_flushed',{token:e.payload.token,label:host.windowId(),error:String(err)}).catch(fail));
    }));
    bind(listen<{token:string;success:boolean}>('board-operation-end',e=>{
      if(operationToken.current!==e.payload.token)return;operationToken.current=null;
      if(!e.payload.success){frozen.current=false;setBusy(false);return;}
      host.loadDocument().then(d=>{
        const b=d.boards.find(b=>b.id===boardId);if(b)latest.current={doc:d,board:b,items:d.items.filter(i=>i.boardId===boardId)};
        setDoc(d);editorRef.current?.resetHistory();
      }).catch(fail).finally(()=>{frozen.current=false;setBusy(false);});
    }));
    bind(listen('collision-disabled', () => patchBoard({ collision: false })));
    bind(listen<string>('collision-error', e => fail(e.payload)));
    bind(listen<{hidden:boolean;edge:'left'|'right'|'top'|'bottom'|null}>('edge-hide-state',e=>setEdgeState(e.payload)));
    bind(listen<string>('edge-hide-error',e=>{patchBoard({edgeHide:false});fail(e.payload);}));
    bind(listen<{ origin: string }>('board-changed', e => { if (e.payload.origin === host.windowId()) return; host.loadDocument().then(d => setDoc(['split','structure'].includes(e.payload.origin) ? d : { ...d, boards: d.boards.map(b => b.id === boardId ? latest.current.board : b), items: [...d.items.filter(i => i.boardId !== boardId), ...latest.current.items] })).catch(fail); }));
    return () => { stopped = true; if (geometryTimer) clearTimeout(geometryTimer); disposers.forEach(fn => fn()); };
  }, [ready, boardId, flush, receivePaths, patchBoard, fail]);
  useEffect(()=>{
    if(!host.native||!ready)return;
    invoke('edge_hide_activity',{label:host.windowId(),enabled:board.edgeHide,style:board.bookmarkStyle??'heart',blocked:!!(locked||busy||settingsOpen||bookmarkOpen||menu||tools||pencil||eraser||marquee||cut||preview||boardDialog||pendingPaths||dropping||!doc.settings.onboardingDone)}).catch(fail);
  },[ready,board.edgeHide,board.bookmarkStyle,locked,busy,settingsOpen,bookmarkOpen,menu,tools,pencil,eraser,marquee,cut,preview,boardDialog,pendingPaths,dropping,doc.settings.onboardingDone,fail]);
  useEffect(() => {
    const key = (e: globalThis.KeyboardEvent) => {
      if (latest.current.board.locked || frozen.current || cut) return;
      if ((e.target as HTMLElement).closest('input,textarea,select,[contenteditable=true]')) return;
      if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? editorRef.current?.redo() : editorRef.current?.undo(); }
      else if (e.ctrlKey && e.key.toLowerCase() === 'y') { e.preventDefault(); editorRef.current?.redo(); }
      else if (e.key === 'Escape') { setMenu(false); setSettingsOpen(false);setBookmarkOpen(false); setPreview(null); setBoardDialog(null);setTools(false);setPencil(false);setEraser(null);setMarquee(false); }
      else if (e.key.startsWith('Arrow') && !preview && !settingsOpen && !bookmarkOpen) { e.preventDefault(); const step = e.shiftKey ? 10 : 1; host.nudge(e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0).catch(fail); }
    }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [preview,settingsOpen,bookmarkOpen,cut,fail]);
  async function launch(item: Item) { try { await flush(); await host.openItem(item); } catch (e) { fail(e); } }
  async function exportBoard() {
    try { await flush(); if (host.native) setError(`已导出：${await invoke<string>('export_markdown', { contents: paperMarkdown(latest.current.board.paperRows??[],latest.current.items) })}`);
      else { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([paperMarkdown(latest.current.board.paperRows??[],latest.current.items)], { type: 'text/markdown;charset=utf-8' })); a.download = '待办板.md'; a.click(); URL.revokeObjectURL(a.href); }
    } catch (e) { fail(e); }
  }
  const bookmarkLayout=bookmarkMetrics(board.bookmarkStyle);
  const paperColor = board.theme.paper ?? '#fff0f5';
  const paperRgb = /^#[\da-f]{6}$/i.test(paperColor) ? [1, 3, 5].map(n => parseInt(paperColor.slice(n, n + 2), 16)).join(', ') : '255, 240, 245';
  if(ready && !doc.boards.some(b=>b.id===boardId)) return <div className="boot">板子已删除，可从托盘新建板子。</div>;
  if (!ready) return <div className="boot">{error || '正在打开待办板…'}{error && <button onClick={() => window.location.reload()}>重试</button>}</div>;
  return <div className={`board-shell ${edgeState.hidden?'edge-hidden':''}`} style={{'--bookmark-gutter':`${bookmarkLayout.gutter}px`,'--bookmark-width':`${bookmarkLayout.width}px`,'--bookmark-height':`${bookmarkLayout.height}px`} as CSSProperties}><Bookmark style={board.bookmarkStyle} armed={board.edgeHide} hidden={edgeState.hidden} edge={edgeState.edge} disabled={locked||busy||cut} onClick={()=>void toggleBookmark()}/><main ref={boardElement} className={`board ${dropping ? 'dropping' : ''} ${board.collapsed ? 'collapsed' : ''} ${locked ? 'locked' : ''} ${busy ? 'busy' : ''}`} inert={busy||edgeState.hidden} style={{ '--accent': board.theme.accent, '--paper-rgb': paperRgb, '--paper-alpha': board.theme.opacity, '--line-alpha': board.grid.lineOpacity, '--line-height': `${lineHeight}px`, '--paper-font-size': `${13*lineHeight/24}px`, '--line-bottom': `${lineHeight - 1}px`, opacity: edgeState.hidden ? 0 : !locked && board.autoFade.enabled && !hover && !settingsOpen && !bookmarkOpen && !pencil && !eraser && !marquee && !tools && !preview && !cut && !boardDialog ? board.autoFade.idleOpacity : 1 } as CSSProperties} onContextMenu={e => { if(locked){e.preventDefault();return;}if(pencil||eraser||marquee||tools||menu||settingsOpen||bookmarkOpen||preview||boardDialog||pendingPaths){e.preventDefault();setPendingPaths(null);setDropping(false);setMenu(false);setSettingsOpen(false);setBookmarkOpen(false);setPreview(null);setBoardDialog(null);writeMode();} }} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
    <header className="toolbar" onPointerDown={e => {
      if (locked || cut || e.button !== 0 || (e.target as Element).closest('button, input, textarea, select')) return;
      e.preventDefault(); if (host.native) invoke('drag_board', { label: host.windowId() }).catch(fail);
    }}>
      <button className="lock-toggle" aria-label={locked ? '解锁板子' : '锁定板子'} aria-pressed={locked} title={locked ? '板子已锁定，点击解锁' : '锁定板子，保留图标碰撞动画'} onClick={toggleLock}>{locked ? <LockKeyhole size={16} /> : <UnlockKeyhole size={16} />}</button><span className="title">随手记</span><span className="count">{locked ? '已锁定' : `${items.filter(i => i.type === 'text').length} 行`}</span>
      <div className="toolbar-actions" inert={locked}><button aria-label="绘图与裁剪" title="铅笔 / 橡皮擦 / 剪刀" disabled={locked||board.collapsed} className={pencil||eraser||marquee||cut?'scissors active':'scissors'} onClick={()=>setTools(!tools)}>{marquee?<Scan size={16}/>:eraser?<Eraser size={16}/>:pencil?<Pencil size={16}/>:<Scissors size={16}/>}</button><button title="撤销 Ctrl+Z" onClick={()=>editorRef.current?.undo()} disabled={locked||!canUndo}><Undo2 size={16} /></button><button disabled={locked} aria-label="更多工具" title="更多工具" onClick={() => setMenu(!menu)}><Ellipsis size={19} /></button><button disabled={locked} title="隐藏到托盘" onClick={() => host.native ? flush().then(() => getCurrentWindow().hide()).catch(fail) : void toggleBookmark()}><Minus size={16} /></button></div>
    </header>
    {tools && <nav className="menu tools-menu"><button onClick={()=>{setPencil(true);setEraser(null);setMarquee(false);setTools(false);}}><Pencil/>铅笔绘画</button><button onClick={()=>{setPencil(false);setEraser('ink');setMarquee(false);setTools(false);}}><Eraser/>铅笔橡皮擦</button><button onClick={()=>{setPencil(false);setEraser('text');setMarquee(false);setTools(false);}}><FileText/>文字橡皮擦</button><button onClick={()=>{setPencil(false);setEraser(null);setMarquee(true);setTools(false);}}><Scan/>框选移动</button><button aria-label="剪刀裁剪" onClick={beginCut}><Scissors/>剪刀裁剪</button></nav>}
    {menu && <nav className="menu"><button onClick={()=>{setBookmarkOpen(true);setMenu(false);}}><BookmarkIcon />书签样式</button><button onClick={() => { setSettingsOpen(true); setMenu(false); }}><Settings2 />外观与设置</button>{host.native && <><button onClick={()=>operate('new')}><Plus />新建板子</button><button onClick={()=>{setBoardDialog('merge');setMenu(false);}} disabled={doc.boards.length<2}><Plus />合并板子</button><button onClick={()=>{setBoardDialog('delete');setMenu(false);}}><Trash2 />删除板子</button><button onClick={()=>{setBoardDialog('restore');setMenu(false);}} disabled={!doc.deletedBoards?.length}><Undo2 />恢复已删除板子</button><button onClick={() => { host.fitBoard(false).catch(fail); setMenu(false); }}><Grip />按图标网格适配</button><button onClick={() => { flush().then(()=>host.fitBoard(true)).then(()=>patchBoard({collision:true})).catch(fail); setMenu(false); }}><Grip />保持尺寸居中</button></>}<button onClick={() => { exportBoard(); setMenu(false); }}><Download />导出 Markdown</button>{selected && <button onClick={() => { flush().then(() => setPreview(items.find(i => i.id === selected) ?? null)).catch(fail); setMenu(false); }}><FileText />预览所选条目</button>}{host.native && <><button onClick={() => { flush().then(() => invoke('restore_icons')).then(() => setError('桌面图标已恢复')).catch(fail); setMenu(false); }}><Undo2 />恢复桌面图标位置</button><button onClick={() => flush().then(() => invoke('quit_app')).catch(fail)}><X />退出</button></>}</nav>}
    {!board.collapsed && <>
      <div className="board-caption" onPointerDown={e => { if (!locked && !cut && e.button === 0) { e.preventDefault(); if (host.native) invoke('drag_board', { label: host.windowId() }).catch(fail); } }}><span>{board.edgeHide ? '贴边收缩已开启 · 离开 1 秒隐藏' : '整板编辑 · 空行优先缓冲'}</span><span className="save-state">{status}</span></div>
      <section ref={paper} inert={locked} className={`paper ${cut?'cutting':''}`} aria-label="自由书写区域" onDragOver={e=>e.preventDefault()} onDrop={e=>{
        e.preventDefault();if(locked||cut)return;const text=e.dataTransfer.getData('text/uri-list').split('\n').find(s=>/^https?:\/\//i.test(s))??e.dataTransfer.getData('text/plain');
        if(/^https?:\/\//i.test(text)){try{const url=new URL(text.trim());editorRef.current?.insertItems([{id:newId(),boardId:board.id,type:'link',url:url.href,title:url.hostname,createdAt:new Date().toISOString()}]);}catch(err){fail(err);}}
      }}>
        <PaperEditor ref={editorRef} boardId={board.id} rows={board.paperRows} ink={board.ink} items={items} spacing={lineHeight} disabled={locked||cut||busy} pencil={pencil} marquee={marquee} eraser={eraser} onChange={onPaper} onHistory={setCanUndo} onOpen={launch} onSelect={item=>setSelected(item.id)}/>
      </section>
      <footer><span>{cut ? '按住左键划过纸面 · 右键取消' : marquee?'拖动框选 · 左键放置 · 右键取消':eraser==='text'?'拖动擦除文字 · 右键返回书写':eraser==='ink'?'拖动擦除画迹 · 右键返回书写':pencil?'Shift+拖动划线 · 右键返回书写':'Enter 换行 · 按住图标拖动'}</span><span>{items.length} 条</span></footer>
    </>}
    {error && <div className="notice" inert={locked} role="status"><span>{error}</span><button aria-label="关闭提示" onClick={() => setError('')}><X size={14} /></button></div>}
    {cutPreview && <CutSurface scene={cutPreview} finish={gesture=>{setCutPreview(null);setCut(false);if(gesture)setError('裁剪窗口请在桌面版中使用。');}}/>}
    {boardDialog && <div className="modal-backdrop"><section className="modal"><header><h2>{boardDialog==='merge'?'合并到当前板子':boardDialog==='delete'?'删除这块板子？':'恢复已删除板子'}</h2><button aria-label="关闭板子操作" onClick={()=>setBoardDialog(null)}><X size={18}/></button></header>
      {boardDialog==='delete'?<><p>内容会移入可恢复的存档，关联的原文件会保留。删掉最后一块后，可从托盘新建板子。</p><div className="dialog-actions"><button onClick={()=>setBoardDialog(null)}>取消</button><button className="primary" onClick={()=>operate('delete')}>删除并保留存档</button></div></>:<><p>{boardDialog==='merge'?'两块板子的内容会保留，使用当前板子的主题。根据两块板子的当前位置左右或上下合并。':'恢复后会重新打开板子。'}</p><div className="board-actions">{(boardDialog==='merge'?doc.boards.filter(b=>b.id!==boardId):(doc.deletedBoards??[]).map(r=>r.board)).map((b,index)=>{const content=(boardDialog==='merge'?doc.items:doc.archive).filter(i=>i.boardId===b.id);const name=content.find(i=>i.text||i.title);return <button key={b.id} disabled={boardDialog==='merge'&&b.locked} onClick={()=>operate(boardDialog,b.id)}>{(name?.text??name?.title??`板子 ${index+1}`).slice(0,30)} · {content.length} 项{b.locked?'（已锁定）':''}</button>;})}</div></>}
    </section></div>}
    {bookmarkOpen && <BookmarkPicker board={board} onChange={patchBookmark} onClose={()=>setBookmarkOpen(false)}/>}
    {settingsOpen && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setSettingsOpen(false); }}><section className="settings modal"><header><h2>让板子适合你</h2><button aria-label="关闭设置" onClick={() => setSettingsOpen(false)}><X size={18} /></button></header><label>文字与线条颜色<div className="swatches">{colors.map(color => <button key={color} aria-label={`主题 ${color}`} className={board.theme.accent === color ? 'active' : ''} style={{ background: color }} onClick={() => patchBoard({ theme: { ...board.theme, accent: color } })} />)}<input aria-label="自定义主题颜色" type="color" value={board.theme.accent} onChange={e => patchBoard({ theme: { ...board.theme, accent: e.target.value } })} /></div></label><label className="row">整板背景颜色<input aria-label="背景颜色" type="color" value={paperColor} onChange={e => patchBoard({ theme: { ...board.theme, paper: e.target.value } })} /></label><label>板子不透明度 <span>{Math.round(board.theme.opacity * 100)}%</span><input type="range" min="0.2" max="1" step="0.01" value={board.theme.opacity} onChange={e => patchBoard({ theme: { ...board.theme, opacity: +e.target.value } })} /></label><label>行距与字号<span>{lineHeight} px / {(13*lineHeight/24).toFixed(1)} px</span><input aria-label="下划线间距" type="range" min="16" max="64" step="1" value={lineHeight} onChange={e => setLineSpacing(+e.target.value)} /></label><label>下划线不透明度 <span>{Math.round(board.grid.lineOpacity * 100)}%</span><input type="range" min="0" max="1" step="0.01" value={board.grid.lineOpacity} onChange={e => patchBoard({ grid: { ...board.grid, lineOpacity: +e.target.value } })} /></label><label className="row">鼠标离开时淡出<input type="checkbox" checked={board.autoFade.enabled} onChange={e => patchBoard({ autoFade: { ...board.autoFade, enabled: e.target.checked } })} /></label><label className="row">开机启动<input type="checkbox" checked={doc.settings.autostart} onChange={async e => { const enabled = e.target.checked; try { await host.setAutostart(enabled); setDoc(d => ({ ...d, settings: { ...d.settings, autostart: enabled } })); } catch (err) { fail(err); } }} /></label><label className="row">文件拖入方式<select value={doc.settings.fileMode ?? ''} onChange={e => setDoc(d => ({ ...d, settings: { ...d.settings, fileMode: e.target.value === '' ? null : e.target.value as 'ref' | 'managed' } }))}><option value="">下次询问</option><option value="ref">引用原文件</option><option value="managed">复制并托管</option></select></label>{host.native && <><label className="row">窗口层级<select value={board.level} onChange={async e => { const level = e.target.value as Board['level']; try { await host.applyLevel(level); patchBoard({ level }); } catch (err) { fail(err); } }}><option value="desktop">桌面层</option><option value="top">总在最前</option><option value="bottom">置底</option><option value="wallpaper" disabled>壁纸层（实验性）</option></select></label><p className="bookmark-help">点击左上角书签开启贴边收缩。拖到任一屏幕边缘，移开鼠标 1 秒后只留下书签；点击书签展开并关闭收缩。</p><label className="row">桌面图标让位动画<input type="checkbox" checked={board.collision} onChange={e => { const enabled = e.target.checked; flush().then(() => invoke('set_collision', { label: host.windowId(), enabled })).then(() => { patchBoard({ collision: enabled }); return flush(); }).catch(fail); }} /></label></>}<p className="muted">方向键移动 1 像素，Shift + 方向键移动 10 像素。文件和程序双击才会打开。</p><button className="primary" onClick={() => { setSettingsOpen(false); flush().catch(fail); }}>完成</button></section></div>}
    {!doc.settings.onboardingDone && <div className="modal-backdrop"><section className="modal"><h2>每次开机，都在桌面等你？</h2><p>可以让待办板随 Windows 启动。之后随时能在设置中更改。</p><div className="dialog-actions"><button onClick={() => setDoc(d => ({ ...d, settings: { ...d.settings, onboardingDone: true } }))}>暂不开启</button><button className="primary" onClick={async () => { try { await host.setAutostart(true); setDoc(d => ({ ...d, settings: { ...d.settings, autostart: true, onboardingDone: true } })); } catch (e) { fail(e); } }}>开机启动</button></div></section></div>}
    {pendingPaths && <div className="modal-backdrop"><section className="modal"><h2>文件放在哪里？</h2><p>引用保留原位置，内容始终最新。托管复制一份到板子的资料目录。文件夹和快捷方式始终引用原位置。</p><div className="dialog-actions"><button onClick={() => setPendingPaths(null)}>取消</button><button onClick={() => receivePaths(pendingPaths, 'ref')}>引用原文件</button><button className="primary" onClick={() => receivePaths(pendingPaths, 'managed')}>复制并托管</button></div></section></div>}
    {preview && <Preview item={preview} onClose={() => setPreview(null)} />}
    {host.native && !locked && !cut && edges.map(direction => <div key={direction} className={`resize resize-${direction}`} onPointerDown={e => { if (e.button !== 0) return; if (e.shiftKey && direction.length > 5) host.resizeWithRatio(e.currentTarget, e.pointerId, direction, e.screenX, e.screenY).catch(fail); else getCurrentWindow().startResizeDragging(direction).catch(fail); }} />)}
  </main></div>;
}

