import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { CollisionWorld, shapeFromAlpha } from './collision-model';
import type { DesktopScene, Rect, Shape } from './collision-model';
import { desktopBitmap } from './icon-image';

export default function CollisionOverlay() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    document.body.style.padding = '0';
    let disposed = false, frame = 0, world: CollisionWorld | null = null;
    let painted = false, loading = false, generation = 0, committing = false;
    let pendingMove: { token: number; boards: Rect[]; areas: Rect[] } | null = null;
    let lastMove = performance.now(), previous = 0, lastPulse = 0, lastRegions = 0;
    const images = new Map<string, { src: string; bitmap: HTMLCanvasElement }>(), shapes = new Map<string, Shape>();
    const diagnostic = () => import.meta.env.DEV || !!(window as Window & { __COLLISION_DIAGNOSTICS__?: boolean }).__COLLISION_DIAGNOSTICS__;
    let lastDiagnostics = 0, regionKey = '';
    const unlisteners: (() => void)[] = [];
    const bind = <T,>(event: string, callback: (payload: T) => void) => listen<T>(event, e => callback(e.payload)).then(off => disposed ? off() : unlisteners.push(off));
    const draw = () => {
      const c = canvas.current, ctx = c?.getContext('2d'); if (!c || !ctx || !world) return;
      const scene = world.scene, scale = window.devicePixelRatio || 1;
      const width = Math.round(window.innerWidth * scale), height = Math.round(window.innerHeight * scale);
      if (c.width !== width || c.height !== height) { c.width = width; c.height = height; }
      ctx.clearRect(0, 0, width, height);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      let active = 0, rotation = 0;
      for (const icon of scene.icons) {
        const p = world.bodies.get(icon.id)!; if (!p.active) continue;
        active++; rotation = Math.max(rotation, Math.abs(p.angle));
        const x = p.x - scene.origin.x, y = p.y - scene.origin.y;
        const size = scene.iconSize, cx = x + size / 2;
        const image = images.get(icon.id)?.bitmap;
        if (image) {
          ctx.save(); ctx.translate(cx, y + size / 2 + (scene.iconOffsetY ?? Math.round(2 * scale))); ctx.rotate(p.angle);
          ctx.drawImage(image, -size / 2, -size / 2, size, size); ctx.restore();
        }

      }
      // Read-only diagnostics used by the native presentation regression test.
      c.dataset.active = String(active); c.dataset.rotation = String(rotation); c.dataset.token = String(scene.token);
      if (diagnostic() && performance.now() - lastDiagnostics > 100) {
        lastDiagnostics = performance.now();
        c.dataset.states = JSON.stringify([...world.bodies.values()].map(p => ({ id: p.id, x: p.x, y: p.y, angle: p.angle, active: p.active })));
        c.dataset.boards = JSON.stringify(scene.boards); c.dataset.navigation = JSON.stringify(world.navigationState);
      }
    };
    const animate = (now: number) => {
      if (disposed) return; frame = requestAnimationFrame(animate);
      if (!world || loading) { previous = now; return; }
      const dt = Math.min(.04, (now - (previous || now)) / 1000); previous = now;
      const began = performance.now();
      if (painted && !(window as Window & { __COLLISION_PAUSE__?: boolean }).__COLLISION_PAUSE__) world.step(dt);
      if (diagnostic() && canvas.current) canvas.current.dataset.stepMs = String(performance.now() - began);
      if (!world.sleeping) draw();
      const activeBodies = [...world.bodies.values()].filter(p => p.active), key = activeBodies.map(p => p.id).join('\n');
      if (painted && (key !== regionKey || now - lastRegions > (world.sleeping ? 250 : 33))) {
        regionKey = key;
        lastRegions = now;
        invoke('collision_hit_regions', { token: world.scene.token, icons: activeBodies.map(p => ({ id: p.id, x: p.x, y: p.y + (world!.scene.iconOffsetY ?? Math.round(2 * devicePixelRatio)), angle: p.angle, active: p.active })) }).catch(() => {});
      }
      if (painted && now - lastPulse > 600) { lastPulse = now; invoke('collision_painted', { token: world.scene.token }).catch(() => {}); }
      // Keep the collision bodies (and hidden names) alive while a board holds
      // them aside. Only remove the animation once every body has returned home.
      if (painted && world.allHome && now - lastMove > 450 && !committing) {
        committing = true; invoke('collision_settled', { token: world.scene.token, targets: world.targets }).catch(() => { committing = false; });
      }
    };
    Promise.all([
      bind<DesktopScene>('collision-scene', async next => {
        const same = world?.scene.token === next.token, current = ++generation;
        loading = true; lastMove = performance.now();
        if (!same) { painted = false; committing = false; world = null; }
        try {
          await Promise.all(next.icons.map(async icon => {
            if (!icon.image) { images.delete(icon.id); shapes.delete(icon.id); icon.pinned = true; return; }
            const key=`${next.iconSize}:${icon.image}:${icon.referenceImage??''}`;
            if (images.get(icon.id)?.src === key) return;
            try {
              const img = new Image(); img.src = icon.image; await img.decode();
              let reference:HTMLImageElement|undefined;if(icon.referenceImage){reference=new Image();reference.src=icon.referenceImage;await reference.decode();}
              const mask = desktopBitmap(img,next.iconSize,reference);
              const ctx = mask.getContext('2d', { willReadFrequently: true })!;
              shapes.set(icon.id, shapeFromAlpha(ctx.getImageData(0, 0, mask.width, mask.height).data, mask.width, mask.height, next.iconSize)); images.set(icon.id, { src: key, bitmap: mask });
            } catch {
              images.delete(icon.id); shapes.delete(icon.id); icon.pinned = true;
            }
          }));
          if (disposed || current !== generation) return;
          const latest = pendingMove?.token === next.token ? { ...next, boards: pendingMove.boards, areas: pendingMove.areas } : next;
          if (same && world) world.update(latest, shapes); else world = new CollisionWorld(latest, shapes);
          loading = false; draw();
          if (!painted) {
            // HWND and WebView2 content are already visible, with Explorer still
            // present. Wait for layout and two canvas frames. Native code also
            // checks layered-window initialization before clipping active original cells.
            await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
            if (disposed || current !== generation || !world) return;
            draw(); await invoke('collision_painted', { token: next.token });
            painted = true; previous = performance.now();
          }
        } catch { invoke('collision_failed', { token: next.token, message: '部分桌面图标无法绘制，已保留原生桌面。' }).catch(() => {}); world = null; loading = false; }
      }),
      bind<{ token: number; boards: Rect[]; areas: Rect[] }>('collision-move', move => {
        pendingMove = move;
        if (world?.scene.token !== move.token) return;
        world.update({ ...world.scene, boards: move.boards, areas: move.areas }); lastMove = performance.now(); committing = false;
      }),
      bind<{ token: number }>('collision-ended', end => {
        if (world?.scene.token === end.token) { generation++; world = null; painted = false; canvas.current?.getContext('2d')?.clearRect(0, 0, canvas.current.width, canvas.current.height); }
      }),
    ]).then(() => { if (!disposed) { frame = requestAnimationFrame(animate); invoke('collision_overlay_ready').catch(() => {}); } });
    return () => { disposed = true; generation++; cancelAnimationFrame(frame); unlisteners.forEach(off => off()); };
  }, []);
  return <canvas ref={canvas} aria-hidden="true" style={{ display: 'block', width: '100%', height: '100%', pointerEvents: 'none' }} />;
}
