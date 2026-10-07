export type Rect = { x: number; y: number; w: number; h: number; radius?: number };
export type IconPoint = { x: number; y: number };
export type DesktopIcon = IconPoint & { id: string; name: string; image: string; referenceImage?:string; home: IconPoint; pinned?: boolean };
export type DesktopScene = { token: number; icons: DesktopIcon[]; grid: IconPoint; iconSize: number; iconOffsetY?: number; iconInsetX?: number; origin: IconPoint; areas: Rect[]; boards: Rect[] };
export const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
export type Sample = IconPoint & { radius: number };
type DistanceField = { width: number; cell: number; origin: number; d: Float32Array; nx: Float32Array; ny: Float32Array };
export type Shape = { samples: Sample[]; inertia: number; field?: DistanceField; edgeIndices?: number[] };
export type Body = IconPoint & { id: string; home: IconPoint; vx: number; vy: number; angle: number; spin: number; active: boolean; pinned: boolean; shape: Shape };
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

// Occupied alpha cells, rather than the Shell label rectangle or a convex hull.
// Transparent holes and gaps remain empty. At desktop size each cell is <= 3px.
export function shapeFromAlpha(rgba: ArrayLike<number>, width: number, height: number, size: number): Shape {
  const samples: Sample[] = [], stride = Math.max(1, Math.ceil(width / 20));
  let moment = 0, weight = 0;
  for (let y = 0; y < height; y += stride) for (let x = 0; x < width; x += stride) {
    let sum = 0, px = 0, py = 0, count = 0;
    for (let j = y; j < Math.min(height, y + stride); j++) for (let i = x; i < Math.min(width, x + stride); i++) {
      const alpha = rgba[(j * width + i) * 4 + 3];
      if (alpha > 48) { sum += alpha; px += (i + .5) * alpha; py += (j + .5) * alpha; count++; }
    }
    if (!sum) continue;
    const sx = px / sum / width * size - size / 2, sy = py / sum / height * size - size / 2;
    const radius = Math.max(.65, Math.sqrt(count / Math.PI) * size / width);
    samples.push({ x: sx, y: sy, radius }); moment += sum * (sx * sx + sy * sy); weight += sum;
  }
  // Cache a signed alpha distance field once. Pair contacts query it in O(N)
  // instead of rebuilding rotated sample buckets for every pair and substep.
  const cell = size / 20, fw = 24, origin = -size / 2 - cell * 2;
  const occupied = new Uint8Array(fw * fw), d = new Float32Array(fw * fw), nx = new Float32Array(fw * fw), ny = new Float32Array(fw * fw);
  for (let y = 0; y < fw; y++) for (let x = 0; x < fw; x++) {
    const px = Math.floor((origin + (x + .5) * cell + size / 2) / size * width), py = Math.floor((origin + (y + .5) * cell + size / 2) / size * height);
    occupied[y * fw + x] = +(px >= 0 && py >= 0 && px < width && py < height && rgba[(py * width + px) * 4 + 3] > 48);
  }
  for (let y = 0; y < fw; y++) for (let x = 0; x < fw; x++) {
    const k = y * fw + x; let best = Infinity, dx = 0, dy = 0;
    for (let j = 0; j < fw; j++) for (let i = 0; i < fw; i++) if (occupied[j * fw + i] !== occupied[k]) {
      const length = (i - x) ** 2 + (j - y) ** 2; if (length < best) { best = length; dx = i - x; dy = j - y; }
    }
    const length = Math.sqrt(best); d[k] = Number.isFinite(length) ? (occupied[k] ? -1 : 1) * Math.max(.1, length * cell - cell / 2) : size * 2;
    if (length > 0 && Number.isFinite(length)) { nx[k] = (occupied[k] ? 1 : -1) * dx / length; ny[k] = (occupied[k] ? 1 : -1) * dy / length; }
  }
  const edgeIndices: number[] = [];
  samples.forEach((p, i) => { const x = clamp(Math.floor((p.x - origin) / cell), 0, fw - 1), y = clamp(Math.floor((p.y - origin) / cell), 0, fw - 1); if (d[y * fw + x] >= -cell) edgeIndices.push(i); });
  return { samples, inertia: Math.max(size * size / 24, moment / Math.max(1, weight)), field: { width: fw, cell, origin, d, nx, ny }, edgeIndices };
}
export function squareShape(size: number): Shape {
  const rgba = new Uint8Array(size * size * 4); for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  return shapeFromAlpha(rgba, size, size, size);
}

// Signed distance and outward normal of a rounded rectangle in screen pixels.
export function boardDistance(p: IconPoint, b: Rect) {
  const radius = Math.min(b.radius ?? 12, b.w / 2, b.h / 2);
  const dx = p.x - b.x - b.w / 2, dy = p.y - b.y - b.h / 2;
  const qx = Math.abs(dx) - b.w / 2 + radius, qy = Math.abs(dy) - b.h / 2 + radius;
  const ox = Math.max(0, qx), oy = Math.max(0, qy), length = ox && oy ? Math.sqrt(ox * ox + oy * oy) : ox + oy;
  const d = length + Math.min(Math.max(qx, qy), 0) - radius;
  const nx = length ? ox / length * Math.sign(dx) : qx > qy ? (dx >= 0 ? 1 : -1) : 0;
  const ny = length ? oy / length * Math.sign(dy) : qx > qy ? 0 : (dy >= 0 ? 1 : -1);
  return { d, nx, ny };
}
export function worldSamples(body: Body, size: number, offsetY = 0): Sample[] {
  const cos = Math.cos(body.angle), sin = Math.sin(body.angle);
  return body.shape.samples.map(p => ({ x: body.x + size / 2 + p.x * cos - p.y * sin, y: body.y + size / 2 + offsetY + p.x * sin + p.y * cos, radius: p.radius }));
}

export class CollisionWorld {
  readonly bodies = new Map<string, Body>();
  scene: DesktopScene;
  private previousBoards: Rect[];
  private time = 0;
  private plans = new Map<string, { time: number; points: IconPoint[] }>();
  private ranks = new Map<string, number>();
  private nextRank = 0;
  private routeBudget = 0;
  sleeping = false;
  private quietFrames = 0;
  private sampleCache = new WeakMap<Body, { x: number; y: number; angle: number; shape: Shape; points: Sample[]; edge: Sample[] }>();
  private samples(body: Body, edge = false) {
    let cache = this.sampleCache.get(body);
    if (!cache || cache.x !== body.x || cache.y !== body.y || cache.angle !== body.angle || cache.shape !== body.shape) {
      const points = worldSamples(body, this.scene.iconSize, this.scene.iconOffsetY);
      cache = { x: body.x, y: body.y, angle: body.angle, shape: body.shape, points, edge: body.shape.edgeIndices?.map(i=>points[i]) ?? points }; this.sampleCache.set(body, cache);
    }
    return edge ? cache.edge : cache.points;
  }
  constructor(scene: DesktopScene, shapes: Map<string, Shape>) {
    this.scene = scene; this.previousBoards = scene.boards;
    this.update(scene, shapes);
  }
  update(scene: DesktopScene, shapes?: Map<string, Shape>) {
    this.sleeping = false; this.quietFrames = 0;
    this.scene = scene;
    for (const icon of scene.icons) {
      const old = this.bodies.get(icon.id);
      if (old) {
        old.home = icon.home; old.pinned = !!icon.pinned; if (shapes?.has(icon.id)) old.shape = shapes.get(icon.id)!;
        if (old.pinned) { Object.assign(old, { x: icon.x, y: icon.y, vx: 0, vy: 0, angle: 0, spin: 0, active: false }); this.ranks.delete(old.id); this.plans.delete(old.id); }
      }
      else this.bodies.set(icon.id, { id: icon.id, x: icon.x, y: icon.y, home: icon.home, vx: 0, vy: 0, angle: 0, spin: 0, active: !icon.pinned && (icon.x !== icon.home.x || icon.y !== icon.home.y), pinned: !!icon.pinned, shape: shapes?.get(icon.id) ?? squareShape(Math.round(scene.iconSize)) });
    }
    const ids = new Set(scene.icons.map(i => i.id)); for (const id of this.bodies.keys()) if (!ids.has(id)) this.bodies.delete(id);
  }
  step(seconds: number) {
    if (this.sleeping) return;
    const dt = clamp(seconds, 0, .05); if (!dt) return; this.time += dt; this.routeBudget = 2;
    const { boards, iconSize: size, areas } = this.scene;
    const previous = new Map([...this.bodies.values()].filter(b=>b.active).map(b=>[b.id,{x:b.x,y:b.y,angle:b.angle}]));
    const travel = Math.max(0, ...boards.map((b, i) => { const old = this.previousBoards[i] ?? b; return Math.max(Math.hypot(b.x - old.x, b.y - old.y), Math.abs(b.w - old.w), Math.abs(b.h - old.h)); }));
    // Interpolate the moving collider, so a fast drag cannot jump through icons.
    const steps = Math.max(1, Math.min(160, Math.max(Math.ceil(dt * 120), Math.ceil(travel / Math.max(2, size / 5))))), h = dt / steps;
    const speeds = boards.map((b, i) => { const old = this.previousBoards[i] ?? b; return { x: clamp((b.x - old.x) / dt, -1800, 1800), y: clamp((b.y - old.y) / dt, -1800, 1800) }; });
    for (let step = 1; step <= steps; step++) {
      const obstacles = boards.map((b, i) => { const old = this.previousBoards[i] ?? b, t = step / steps; return { ...b, x: old.x + (b.x - old.x) * t, y: old.y + (b.y - old.y) * t, w: old.w + (b.w - old.w) * t, h: old.h + (b.h - old.h) * t }; });
      for (const body of this.bodies.values()) {
        if (body.pinned || !body.active) continue;
        const steering = this.returnSteering(body, obstacles);
        body.vx += (45 * (body.home.x - body.x + steering.x) - 8 * body.vx) * h;
        body.vy += (45 * (body.home.y - body.y + steering.y) - 8 * body.vy) * h;
        body.spin += (-48 * body.angle - 7 * body.spin) * h;
        body.x += body.vx * h; body.y += body.vy * h;
        body.angle = clamp(body.angle + body.spin * h, -.7, .7);
      }
      for (let pass = 0; pass < 3; pass++) {
        for (const body of this.bodies.values()) {
          if (body.pinned) continue;
          for (let i = 0; i < obstacles.length; i++) this.boardContact(body, obstacles[i], speeds[i]);
          if (body.active) this.boundaries(body, areas);
        }
        this.iconContacts(size);
      }
    }
    this.previousBoards = boards.map(b => ({ ...b }));
    for (const body of this.bodies.values()) {
      if (!body.active) continue;
      if (Math.hypot(body.x - body.home.x, body.y - body.home.y) < .3 && Math.hypot(body.vx, body.vy) < 1 && Math.abs(body.angle) < .008 && Math.abs(body.spin) < .025) {
        const atHome = { ...body, x: body.home.x, y: body.home.y, angle: 0 };
        if (!boards.some(b => worldSamples(atHome, size, this.scene.iconOffsetY).some(p => boardDistance(p, b).d < p.radius))) {
          body.x = body.home.x; body.y = body.home.y; body.angle = body.spin = body.vx = body.vy = 0; body.active = false;
          this.ranks.delete(body.id); this.plans.delete(body.id);
        }
      }
    }
    const active = [...this.bodies.values()].filter(b=>b.active);
    const quiet = active.length > 0 && active.every(b=>{const p=previous.get(b.id);return p && Math.hypot(p.x-b.x,p.y-b.y)+Math.abs(p.angle-b.angle)*size*.7<.2});
    this.quietFrames = quiet ? this.quietFrames + 1 : 0;
    // Sleep only a static, blocked group. Free returners must never sleep on a
    // contact deadlock. Any geometry/native-layout update wakes every body.
    if (this.quietFrames >= 20 && active.every(body=>boards.some(b=>worldSamples({...body,x:body.home.x,y:body.home.y,angle:0},size,this.scene.iconOffsetY).some(p=>boardDistance(p,b).d<p.radius)))) {
      this.sleeping = true; for (const body of active) body.vx = body.vy = body.spin = 0;
    }
  }
  private returnSteering(body: Body, boards: Rect[]): IconPoint {
    if (!body.active) return { x: 0, y: 0 };
    if (!this.ranks.has(body.id)) this.ranks.set(body.id, ++this.nextRank);
    const size = this.scene.iconSize, offset = this.scene.iconOffsetY ?? 0;
    const length = Math.hypot(body.home.x - body.x, body.home.y - body.y);
    if (length < .5 || boards.some(b => worldSamples({ ...body, x: body.home.x, y: body.home.y, angle: 0 }, size, offset).some(p => boardDistance(p, b).d < p.radius))) {
      this.plans.delete(body.id); return { x: 0, y: 0 };
    }
    let plan = this.plans.get(body.id);
    if ((!plan || this.time - plan.time > .35) && this.routeBudget > 0) {
      this.routeBudget--;
      plan = { time: this.time, points: this.returnPath(body, boards) }; this.plans.set(body.id, plan);
    }
    if (!plan) return { x: 0, y: 0 };
    while (plan.points.length > 1 && Math.hypot(plan.points[0].x - body.x, plan.points[0].y - body.y) < size * .22) plan.points.shift();
    const waypoint = plan.points[0];
    if (!waypoint) return { x: 0, y: 0 };
    const dx = waypoint.x - body.x, dy = waypoint.y - body.y, distance = Math.hypot(dx, dy);
    const atGoal = waypoint.x === body.home.x && waypoint.y === body.home.y;
    // Keep enough drive to make lower-priority neighbors yield. A short path
    // segment otherwise creates a weak spring and a stable contact deadlock.
    const drive = atGoal ? 1 : Math.max(1, Math.min(length, size * 2) / Math.max(1, distance));
    return { x: body.x + dx * drive - body.home.x, y: body.y + dy * drive - body.home.y };
  }
  private returnPath(body: Body, boards: Rect[]): IconPoint[] {
    const size = this.scene.iconSize, offset = this.scene.iconOffsetY ?? 0, cell = Math.max(4, size / 6);
    const start = { x: body.x, y: body.y }, home = body.home;
    const margin = size * 3;
    const minX = Math.min(start.x, home.x) - margin, maxX = Math.max(start.x, home.x) + margin;
    const minY = Math.min(start.y, home.y) - margin, maxY = Math.max(start.y, home.y) + margin;
    const ahead = (b: Body) => b.pinned || (b.active && (this.ranks.get(b.id) ?? Infinity) < (this.ranks.get(body.id) ?? Infinity));
    // Return priority breaks reciprocal deadlocks. Lower-priority bodies remain
    // solid in the contact solver and yield physically, then take their turn.
    const circles = [...this.bodies.values()].filter(b => b !== body && ahead(b) && b.x > minX - size && b.x < maxX + size && b.y > minY - size && b.y < maxY + size).map(b => ({
      x: b.x, y: b.y, radius: Math.min(size * 1.15, Math.max(size * .35, Math.hypot(b.x - start.x, b.y - start.y) - .5)),
    }));
    const area = this.scene.areas.find(a => home.x + size / 2 >= a.x && home.y + size / 2 >= a.y && home.x + size / 2 < a.x + a.w && home.y + size / 2 < a.y + a.h);
    const free = (p: IconPoint) => {
      const cx = p.x + size / 2, cy = p.y + size / 2 + offset;
      return (!area || cx >= area.x + size * .45 && cy >= area.y + size * .45 && cx <= area.x + area.w - size * .45 && cy <= area.y + area.h - size * .45)
        && !circles.some(c => (p.x - c.x) ** 2 + (p.y - c.y) ** 2 < c.radius * c.radius)
        && !boards.some(b => boardDistance({ x: cx, y: cy }, b).d < size * .5);
    };
    const clear = (a: IconPoint, b: IconPoint) => {
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (cell * .6)));
      for (let i = 1; i <= steps; i++) if (!free({ x: a.x + (b.x - a.x) * i / steps, y: a.y + (b.y - a.y) * i / steps })) return false;
      return true;
    };
    if (clear(start, home)) return [home];
    type Node = IconPoint & { gx: number; gy: number; g: number; score: number; parent?: Node };
    const key = (x: number, y: number) => x * 65536 + y;
    const first: Node = { ...start, gx: 0, gy: 0, g: 0, score: Math.hypot(start.x - home.x, start.y - home.y) };
    const open: Node[] = [first], costs = new Map<number, number>([[0, 0]]);
    let nearest = first, reached: Node | null = null;
    for (let iteration = 0; open.length && iteration < 1600; iteration++) {
      let index = 0; for (let i = 1; i < open.length; i++) if (open[i].score < open[index].score) index = i;
      const current = open.splice(index, 1)[0];
      if (current.g > costs.get(key(current.gx, current.gy))!) continue;
      const distance = Math.hypot(current.x - home.x, current.y - home.y);
      if (distance + current.g * .015 < Math.hypot(nearest.x - home.x, nearest.y - home.y) + nearest.g * .015) nearest = current;
      if (distance < cell * 1.5 && clear(current, home)) { reached = current; break; }
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        const gx = current.gx + dx, gy = current.gy + dy, x = start.x + gx * cell, y = start.y + gy * cell;
        if (x < minX || x > maxX || y < minY || y > maxY) continue;
        const g = current.g + Math.hypot(dx, dy) * cell, k = key(gx, gy);
        if (g >= (costs.get(k) ?? Infinity) || !free({ x, y }) || !clear(current, { x, y })) continue;
        costs.set(k, g); open.push({ x, y, gx, gy, g, score: g + Math.hypot(x - home.x, y - home.y), parent: current });
      }
    }
    const chain: IconPoint[] = []; let node: Node | undefined = reached ?? nearest;
    while (node?.parent) { chain.unshift({ x: node.x, y: node.y }); node = node.parent; }
    if (reached) chain.push(home);
    const path: IconPoint[] = []; let anchor: IconPoint = start;
    while (chain.length) {
      let index = chain.length - 1; while (index > 0 && !clear(anchor, chain[index])) index--;
      anchor = chain[index]; path.push(anchor); chain.splice(0, index + 1);
    }
    return path;
  }
  private boardContact(body: Body, board: Rect, speed: IconPoint) {
    const size = this.scene.iconSize;
    if (!overlaps({ x: body.x - size / 3, y: body.y - size / 3, w: size * 5 / 3, h: size * 5 / 3 }, board)) return;
    const samples = this.samples(body);
    let depth = 0, contact: (Sample & { nx: number; ny: number }) | null = null;
    for (const p of samples) { const d = boardDistance(p, board), overlap = p.radius - d.d;
      if (overlap > depth) { depth = overlap; contact = { ...p, nx: d.nx, ny: d.ny }; }
    }
    if (!contact || depth <= 0) return;
    this.activate(body);
    let { nx, ny } = contact;
    const area = this.scene.areas.find(a => body.home.x + size / 2 >= a.x && body.home.y + size / 2 >= a.y && body.home.x + size / 2 < a.x + a.w && body.home.y + size / 2 < a.y + a.h);
    if (area) {
      const left = Math.min(...samples.map(p => p.x - p.radius)), right = Math.max(...samples.map(p => p.x + p.radius));
      const top = Math.min(...samples.map(p => p.y - p.radius)), bottom = Math.max(...samples.map(p => p.y + p.radius));
      if (left + nx * depth < area.x || right + nx * depth > area.x + area.w || top + ny * depth < area.y || bottom + ny * depth > area.y + area.h) {
        const exits = [
          { nx: -1, ny: 0, depth: right - board.x + .1 }, { nx: 1, ny: 0, depth: board.x + board.w - left + .1 },
          { nx: 0, ny: -1, depth: bottom - board.y + .1 }, { nx: 0, ny: 1, depth: board.y + board.h - top + .1 },
        ].filter(e => e.depth > 0 && left + e.nx * e.depth >= area.x && right + e.nx * e.depth <= area.x + area.w && top + e.ny * e.depth >= area.y && bottom + e.ny * e.depth <= area.y + area.h).sort((a, b) => a.depth - b.depth);
        if (exits.length) { ({ nx, ny, depth } = exits[0]); }
      }
    }
    const rx = contact.x - body.x - size / 2, ry = contact.y - body.y - size / 2 - (this.scene.iconOffsetY ?? 0);
    body.x += nx * (depth + .08); body.y += ny * (depth + .08);
    const lever = rx * ny - ry * nx;
    const normalSpeed = (body.vx - body.spin * ry - speed.x) * nx + (body.vy + body.spin * rx - speed.y) * ny;
    if (normalSpeed < 0) {
      const impulse = -(1.12 * normalSpeed) / (1 + lever * lever / body.shape.inertia);
      body.vx += impulse * nx; body.vy += impulse * ny; body.spin = clamp(body.spin + lever * impulse / body.shape.inertia, -5, 5);
    }
    // Contact friction adds a small tangential twist, including a glancing push.
    const slip = (speed.x - body.vx) * -ny + (speed.y - body.vy) * nx;
    body.spin = clamp(body.spin + clamp(slip * .00015, -.018, .018), -5, 5);
  }
  private boundaries(body: Body, areas: Rect[]) {
    const size = this.scene.iconSize, cx = body.home.x + size / 2, cy = body.home.y + size / 2;
    const area = areas.find(a => cx >= a.x && cy >= a.y && cx < a.x + a.w && cy < a.y + a.h); if (!area) return;
    const bx = body.x + size / 2, by = body.y + size / 2 + (this.scene.iconOffsetY ?? 0), radius = size * .8;
    if (bx - radius >= area.x && bx + radius <= area.x + area.w && by - radius >= area.y && by + radius <= area.y + area.h) return;
    const points = this.samples(body); if (!points.length) return;
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
    for (const p of points) { left = Math.min(left, p.x - p.radius); right = Math.max(right, p.x + p.radius); top = Math.min(top, p.y - p.radius); bottom = Math.max(bottom, p.y + p.radius); }
    if (left < area.x) { body.x += area.x - left; body.vx = Math.max(0, body.vx); }
    if (right > area.x + area.w) { body.x -= right - area.x - area.w; body.vx = Math.min(0, body.vx); }
    if (top < area.y) { body.y += area.y - top; body.vy = Math.max(0, body.vy); }
    if (bottom > area.y + area.h) { body.y -= bottom - area.y - area.h; body.vy = Math.min(0, body.vy); }
  }
  private pairContact(a: Body, b: Body, size: number) {
    const contact = { depth: 0, normal: null as IconPoint | null };
    const inspect = (from: Body, to: Body, reverse: boolean) => {
      const field = to.shape.field, cos = Math.cos(to.angle), sin = Math.sin(to.angle);
      const cx = to.x + size / 2, cy = to.y + size / 2 + (this.scene.iconOffsetY ?? 0);
      if (!field) return;
      const { width, cell, origin, d, nx, ny } = field;
      for (const p of this.samples(from, true)) {
        const dx = p.x - cx, dy = p.y - cy;
        const gx = (dx * cos + dy * sin - origin) / cell - .5, gy = (-dx * sin + dy * cos - origin) / cell - .5;
        const x = Math.floor(gx), y = Math.floor(gy);
        if (x < 0 || y < 0 || x >= width - 1 || y >= width - 1) continue;
        const tx = gx - x, ty = gy - y, k = y * width + x;
        const w0 = (1 - tx) * (1 - ty), w1 = tx * (1 - ty), w2 = (1 - tx) * ty, w3 = tx * ty;
        const distance = d[k] * w0 + d[k + 1] * w1 + d[k + width] * w2 + d[k + width + 1] * w3;
        const overlap = p.radius - distance;
        if (overlap <= contact.depth) continue;
        const lx = nx[k] * w0 + nx[k + 1] * w1 + nx[k + width] * w2 + nx[k + width + 1] * w3;
        const ly = ny[k] * w0 + ny[k + 1] * w1 + ny[k + width] * w2 + ny[k + width + 1] * w3;
        const length = Math.hypot(lx, ly); if (length < .001) continue;
        const direction = reverse ? 1 : -1;
        contact.depth = overlap; contact.normal = { x: direction * (lx * cos - ly * sin) / length, y: direction * (lx * sin + ly * cos) / length };
      }
    };
    inspect(a, b, false); inspect(b, a, true);
    let { depth, normal } = contact;
    if (!normal || depth <= 0) return;
    // A nearest alpha boundary can face INTO the neighbor when concave sprites
    // interlock. Projecting along that normal swaps sides every pass and traps
    // the pair forever. Keep alpha detection (holes are still empty), but solve
    // an actual contact with a consistent separating axis of the occupied cells.
    const dx = b.x - a.x, dy = b.y - a.y;
    const hx = b.home.x - a.home.x, hy = b.home.y - a.home.y;
    const direction = Math.hypot(dx, dy) > .5 ? { x: dx, y: dy } : { x: hx || 1, y: hy };
    if (depth > size * .1 || normal.x * direction.x + normal.y * direction.y < 0) {
    const axes = [normal, { x: 1, y: 0 }, { x: 0, y: 1 }, direction];
    const pa = this.samples(a, true), pb = this.samples(b, true);
    let best = Infinity, axis: IconPoint | null = null;
    for (const candidate of axes) {
      const length = Math.hypot(candidate.x, candidate.y); if (!length) continue;
      let x = candidate.x / length, y = candidate.y / length;
      if (x * direction.x + y * direction.y < 0) { x = -x; y = -y; }
      let maxA = -Infinity, minB = Infinity;
      for (const p of pa) maxA = Math.max(maxA, p.x * x + p.y * y + p.radius);
      for (const p of pb) minB = Math.min(minB, p.x * x + p.y * y - p.radius);
      const penetration = maxA - minB;
      if (penetration > 0 && penetration < best) { best = penetration; axis = { x, y }; }
    }
    if (axis) { normal = axis; depth = best + .08; }
    }
    const ia = a.pinned ? 0 : 1, ib = b.pinned ? 0 : 1, sum = ia + ib;
    a.x -= normal.x * depth * ia / sum; a.y -= normal.y * depth * ia / sum;
    b.x += normal.x * depth * ib / sum; b.y += normal.y * depth * ib / sum;
    const closing = (b.vx - a.vx) * normal.x + (b.vy - a.vy) * normal.y;
    if (closing < 0) { const impulse = -.65 * closing / sum; a.vx -= impulse * normal.x * ia; a.vy -= impulse * normal.y * ia; b.vx += impulse * normal.x * ib; b.vy += impulse * normal.y * ib; }
    if (ia) this.activate(a); if (ib) this.activate(b);
  }
  private iconContacts(size: number) {
    const bodies = [...this.bodies.values()], cell = size * 1.5, buckets = new Map<number, number[]>();
    const key = (x: number, y: number) => x * 65536 + y;
    for (let i = 0; i < bodies.length; i++) { const b = bodies[i], k = key(Math.floor(b.x / cell), Math.floor(b.y / cell)); const list = buckets.get(k); if (list) list.push(i); else buckets.set(k, [i]); }
    for (let i = 0; i < bodies.length; i++) {
      const a = bodies[i], gx = Math.floor(a.x / cell), gy = Math.floor(a.y / cell);
      for (let x = gx - 1; x <= gx + 1; x++) for (let y = gy - 1; y <= gy + 1; y++) for (const j of buckets.get(key(x, y)) ?? []) {
        if (j <= i) continue;
        const b = bodies[j];
        if ((!a.active && !b.active) || (a.pinned && b.pinned) || Math.abs(a.x - b.x) > size * 1.45 || Math.abs(a.y - b.y) > size * 1.45) continue;
        this.pairContact(a, b, size);
      }
    }
  }
  private activate(body: Body) {
    body.active = true;
    if (!this.ranks.has(body.id)) this.ranks.set(body.id, ++this.nextRank);
  }
  get allHome() { return [...this.bodies.values()].every(b => !b.active); }
  get navigationState() { return { ranks: Object.fromEntries(this.ranks), plans: Object.fromEntries(this.plans) }; }
  get targets(): Record<string, IconPoint> { return Object.fromEntries([...this.bodies.values()].map(b => [b.id, { x: Math.round(b.x), y: Math.round(b.y) }])); }
}
