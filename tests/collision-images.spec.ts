import { test, expect } from '@playwright/test';

test('an unavailable or invalid sprite leaves that native icon alone while other icons animate', async ({ page }) => {
  await page.addInitScript(() => {
    const callbacks = new Map<number, (event: unknown) => void>(), events = new Map<string, number>();
    let sequence = 0;
    Object.assign(window, {
      __collisionCalls: [] as string[],
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __emitCollision: (event: string, payload: unknown) => callbacks.get(events.get(event)!)?.({ event, payload }),
      __TAURI_INTERNALS__: {
        transformCallback: (callback: (event: unknown) => void) => { callbacks.set(++sequence, callback); return sequence; },
        unregisterCallback: (id: number) => callbacks.delete(id),
        invoke: async (command: string, args: { event?: string; handler?: number }) => {
          (window as unknown as { __collisionCalls: string[] }).__collisionCalls.push(command);
          if (command === 'plugin:event|listen') { events.set(args.event!, args.handler!); return sequence; }
        },
      },
    });
  });
  await page.goto('/?overlay=icons');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __collisionCalls: string[] }).__collisionCalls.includes('collision_overlay_ready'))).toBe(true);
  for (const [index, failedImage] of ['', 'data:image/png;base64,broken'].entries()) {
    await page.evaluate(({ token, failedImage }) => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 24;
      const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#e83566'; ctx.fillRect(0, 0, 24, 24);
      const image = canvas.toDataURL();
      (window as unknown as { __emitCollision: (event: string, payload: unknown) => void }).__emitCollision('collision-scene', {
        token, icons: [
          { id: 'protected', name: 'protected', image: failedImage, x: 40, y: 40, home: { x: 40, y: 40 } },
          { id: 'working', name: 'working', image, x: 80, y: 40, home: { x: 80, y: 40 } },
        ], iconSize: 24, grid: { x: 60, y: 60 }, origin: { x: 0, y: 0 },
        boards: [{ x: 30, y: 30, w: 85, h: 45 }], areas: [{ x: 0, y: 0, w: 800, h: 600 }],
      });
    }, { token: index + 1, failedImage });
    await expect.poll(() => page.locator('canvas').evaluate((c, token) => {
      const states = JSON.parse(c.dataset.states ?? '[]') as { id: string; x: number; y: number; active: boolean }[];
      return Number(c.dataset.token) === token && states.length === 2 && states.some(s => s.id === 'protected' && !s.active && s.x === 40 && s.y === 40) && states.some(s => s.id === 'working' && s.active);
    }, index + 1)).toBe(true);
  }
  expect(await page.evaluate(() => (window as unknown as { __collisionCalls: string[] }).__collisionCalls.includes('collision_failed'))).toBe(false);
});
