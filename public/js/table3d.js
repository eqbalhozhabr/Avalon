// Pixel-art 3D round table.
//
// The seating order is fixed for the whole session (seat i sits at table angle
// 2*pi*i/N). Every player gets a camera that is rotated so *their own* seat is
// at the bottom of the screen. Nothing about the table changes between players;
// only the point of view does.
//
// The floor and table-top are drawn per pixel with an inverse perspective
// mapping (screen pixel -> point on a plane), so planks, tiles and the carpet
// really do rotate with the camera. People are pixel sprites chosen by the angle
// they are seen from (back / side / front).

const TAU = Math.PI * 2;

// Camera / projection constants. Heights are in table radii.
const TILT = 0.52; // sin(elevation): how flat the ground plane is squashed
const HGT = Math.sqrt(1 - TILT * TILT); // vertical scale of heights
const PERSP = 0.14; // nearer things are larger
const FLOOR_Y = -0.62; // floor height relative to the table top
const RIM = 0.16; // table thickness
const SEAT_R = 1.2; // radius of the chairs
const SEAT_Y = -0.3; // height of a chair seat
const SPRITE_W = 16;
const SPRITE_H = 22;

const O = '#1b1424'; // outline

export const ROBES = ['#c0392b', '#2e86c1', '#2ea05a', '#8e44ad', '#d68910', '#16a0a0', '#d35491', '#7b8794', '#a0522d', '#4f5bd5'];
const SKINS = ['#f5cba7', '#e8b88a', '#d39a6a', '#a8714a', '#7d5035', '#fadbc0'];
const HAIRS = ['#2b1a12', '#5a3825', '#b5651d', '#e0b35a', '#15131a', '#9a9aa6', '#7a3b12', '#a83232', '#3d4a6b', '#d9c6a3'];

export function lookOf(avatar) {
  const a = Math.abs(avatar | 0);
  const robe = ROBES[a % ROBES.length];
  return {
    robe,
    robeShade: shade(robe, 0.68),
    robeLight: shade(robe, 1.25),
    skin: SKINS[(a * 5 + 1) % SKINS.length],
    hair: HAIRS[(a * 7 + 2) % HAIRS.length],
    style: (a * 5 + 1) % 3, // 0 short hair, 1 long hair, 2 wizard hat
    hat: shade(robe, 0.8),
  };
}

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.max(0, Math.min(255, Math.round(v * f))));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Cheap deterministic hash in [0,1) for tile / grain noise.
function hash2(a, b) {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const post = (c) => Math.round(c / 12) * 12; // posterize: keeps the retro banding

export class Table3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.players = [];
    this.mySeat = 0;
    this.dyn = {};
    this.seats = [];
    this.staticDirty = true;
    this.running = false;
    this.onLayout = null;
    this.resize(canvas.clientWidth || 360);
  }

  // ------------------------------------------------------------------ layout
  resize(cssWidth) {
    const W = Math.max(160, Math.min(272, Math.floor(cssWidth / 2)));
    const S = W * 0.335;
    const top = 58 + 0.31 * S;
    const H = Math.ceil(top + 1.36 * S + 8);
    Object.assign(this, { W, H, S, cx: W / 2, cy: top, A: S * TILT });
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx.imageSmoothingEnabled = false;
    this.staticDirty = true;
    this.computeSeats();
  }

  setPlayers(players, mySeat) {
    const sig = players.map((p) => `${p.id}:${p.avatar}`).join('|') + `@${mySeat}`;
    if (sig === this._sig) {
      this.players = players;
      return;
    }
    this._sig = sig;
    this.players = players;
    this.mySeat = Math.max(0, mySeat);
    this.staticDirty = true;
    this.computeSeats();
  }

  // dyn: { leader, team:Set, pending:Set, cards:{id:'down'|'approve'|'reject'},
  //        center:[ 'success'|'fail' ], selectable:Set, away:Set, peek:{id:mark} }
  setDynamic(dyn) {
    this.dyn = dyn || {};
  }

  project(x, y, z) {
    const f = 1 + PERSP * z;
    return { x: this.cx + x * this.S * f, y: this.cy + z * this.A * f - y * this.S * HGT * f, f };
  }

  computeSeats() {
    const n = this.players.length;
    this.seats = [];
    for (let i = 0; i < n; i++) {
      const theta = ((i - this.mySeat) / n) * TAU; // angle as seen by this viewer
      const x = -Math.sin(theta) * SEAT_R;
      const z = Math.cos(theta) * SEAT_R;
      const base = this.project(x, SEAT_Y, z);
      const floor = this.project(x, FLOOR_Y, z);
      let view = 'side';
      let flip = false;
      const c = Math.cos(theta);
      if (c > 0.5) view = 'back';
      else if (c < -0.5) view = 'front';
      else flip = Math.sin(theta) < 0; // seats on the right face left
      const tok = this.project(-Math.sin(theta) * 0.64, 0, Math.cos(theta) * 0.64);
      this.seats.push({
        i,
        id: this.players[i].id,
        theta,
        wx: x,
        wz: z,
        sx: Math.round(base.x),
        sy: Math.round(base.y),
        fx: Math.round(floor.x),
        fy: Math.round(floor.y),
        f: base.f,
        view,
        flip,
        tokenX: Math.round(tok.x),
        tokenY: Math.round(tok.y),
        sideways: Math.abs(Math.sin(theta)) > 0.7,
        look: lookOf(this.players[i].avatar),
      });
    }
    if (this.onLayout) this.onLayout(this.seatBoxes());
  }

  // Where DOM overlays (name tags, hit areas) should go, in percent of the canvas.
  seatBoxes() {
    return this.seats.map((s) => ({
      id: s.id,
      left: (s.sx / this.W) * 100,
      above: s.wz < 0,
      top: (s.wz < 0 ? s.sy - SPRITE_H - (s.look.style === 2 ? 8 : 0) - 11 : s.fy + 2) / this.H * 100,
      head: ((s.sy - SPRITE_H) / this.H) * 100,
      z: s.wz,
    }));
  }

  // ------------------------------------------------------------------ static layers
  // Solve for the point (x,z) on the horizontal plane at height y0 that lands on screen pixel (px,py).
  planeZ(py, y0) {
    const { A, S, cy } = this;
    const Bp = y0 * S * HGT;
    const qa = PERSP * A;
    const qb = A - PERSP * Bp;
    const qc = -(Bp + py - cy);
    const disc = qb * qb - 4 * qa * qc;
    return (-qb + Math.sqrt(Math.max(0, disc))) / (2 * qa);
  }

  buildStatic() {
    const { W, H, S, cx } = this;
    const n = Math.max(this.players.length, 1);
    const floorImg = new ImageData(W, H);
    const tableImg = new ImageData(W, H);
    const aMe = (TAU * this.mySeat) / n;
    const ca = Math.cos(aMe);
    const sa = Math.sin(aMe);
    const stoneA = hexToRgb('#3a3550');
    const stoneB = hexToRgb('#332e47');
    const carpet = hexToRgb('#6b1f2e');
    const carpet2 = hexToRgb('#7d2a3a');
    const gold = hexToRgb('#c9a24a');
    const woods = [hexToRgb('#9a6a3c'), hexToRgb('#8f6035'), hexToRgb('#a2723f')];
    const seatColors = this.players.map((p) => hexToRgb(ROBES[Math.abs(p.avatar | 0) % ROBES.length]));

    const put = (img, idx, rgb, b) => {
      img.data[idx] = post(rgb[0] * b);
      img.data[idx + 1] = post(rgb[1] * b);
      img.data[idx + 2] = post(rgb[2] * b);
      img.data[idx + 3] = 255;
    };

    for (let py = 0; py < H; py++) {
      const zf = this.planeZ(py, FLOOR_Y);
      const zt0 = this.planeZ(py, 0);
      const zr = this.planeZ(py, -RIM);
      const ff = 1 + PERSP * zf;
      const ft = 1 + PERSP * zt0;
      const fr = 1 + PERSP * zr;
      for (let px = 0; px < W; px++) {
        const idx = (py * W + px) * 4;

        // --- floor ---
        {
          const x = (px - cx) / (S * ff);
          const xt = x * ca - zf * sa;
          const zt = x * sa + zf * ca;
          const r = Math.hypot(xt, zt);
          const tile = 0.46;
          const tx = Math.floor(xt / tile);
          const tz = Math.floor(zt / tile);
          const grout = (xt / tile - tx < 0.07) || (zt / tile - tz < 0.07);
          let rgb = (tx + tz) & 1 ? stoneA : stoneB;
          let b = 0.9 + hash2(tx, tz) * 0.2;
          if (grout) b *= 0.7;
          if (r < 1.74) {
            rgb = (Math.floor(r * 7) + Math.floor(Math.atan2(zt, xt) * n * 0.5)) & 1 ? carpet : carpet2;
            b = 1;
            if (r > 1.58) {
              rgb = r > 1.67 ? gold : [40, 14, 24];
              b = r > 1.67 ? 0.9 : 1;
            }
          }
          // shadow under the table, light falloff away from the candle
          if (r < 1.18) b *= 0.55 + 0.45 * Math.max(0, (r - 0.9) / 0.28);
          b *= 1.12 - 0.34 * Math.min(1, r / 2.2);
          put(floorImg, idx, rgb, b);
        }

        // --- table top & rim ---
        {
          const x = (px - cx) / (S * ft);
          const r2 = x * x + zt0 * zt0;
          if (r2 <= 1) {
            const xt = x * ca - zt0 * sa;
            const zt = x * sa + zt0 * ca;
            const r = Math.sqrt(r2);
            const plank = Math.floor((zt + 1) / 0.2);
            const pf = (zt + 1) / 0.2 - plank;
            let rgb = woods[((plank % 3) + 3) % 3];
            let b = 1 - 0.1 * r2;
            if (pf < 0.07) b *= 0.72;
            else if (hash2(Math.floor(xt * 9), plank) < 0.1) b *= 0.86;
            if (r > 0.94) {
              rgb = woods[2];
              b = r > 0.97 ? 1.18 : 0.9;
            } else if (r > 0.865 && r < 0.905) {
              rgb = gold;
              b = 0.95;
            }
            // placemats in the colour of whoever sits there
            if (this.players.length && r > 0.42 && r < 0.9) {
              const ang = Math.atan2(-xt, zt);
              let k = Math.round((ang / TAU) * n);
              k = ((k % n) + n) % n;
              const sang = (TAU * k) / n;
              const mx = -Math.sin(sang) * 0.7;
              const mz = Math.cos(sang) * 0.7;
              const d = Math.hypot(xt - mx, zt - mz);
              if (d < 0.17) {
                rgb = seatColors[k] || woods[0];
                b = d < 0.1 ? 1 : 0.78;
              }
            }
            // the round stone in the middle
            if (r < 0.26) {
              rgb = r > 0.2 ? gold : hexToRgb('#4b4a5c');
              b = r > 0.2 ? 1 : 0.85 + 0.2 * Math.cos(Math.atan2(zt, xt) * 5) * (r > 0.1 ? 1 : 0);
            }
            put(tableImg, idx, rgb, b);
          } else {
            // rim (side wall) - only where the thickened ellipse still covers the pixel
            const xr = (px - cx) / (S * fr);
            if (xr * xr + zr * zr <= 1) {
              const rgb = woods[1];
              const edge = Math.abs(xr);
              put(tableImg, idx, rgb, 0.55 - 0.15 * edge + (hash2(px >> 1, 3) < 0.1 ? -0.08 : 0));
            }
          }
        }
      }
    }
    this.floorLayer = this.toCanvas(floorImg);
    this.tableLayer = this.toCanvas(tableImg);
    this.staticDirty = false;
  }

  toCanvas(img) {
    const c = document.createElement('canvas');
    c.width = this.W;
    c.height = this.H;
    c.getContext('2d').putImageData(img, 0, 0);
    return c;
  }

  // ------------------------------------------------------------------ frame
  start() {
    if (this.running) return;
    this.running = true;
    const loop = (now) => {
      if (!this.running) return;
      if (!document.hidden && now - (this._last || 0) > 66) {
        this._last = now;
        this.draw(now);
      }
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
  }

  draw(now = performance.now()) {
    if (this.staticDirty) this.buildStatic();
    const ctx = this.ctx;
    ctx.drawImage(this.floorLayer, 0, 0);
    const t = now / 1000;
    const dyn = this.dyn;

    for (const s of this.seats) this.drawFloorMarks(ctx, s, dyn, t);

    const far = this.seats.filter((s) => s.wz < 0).sort((a, b) => a.wz - b.wz);
    const near = this.seats.filter((s) => s.wz >= 0).sort((a, b) => a.wz - b.wz);
    for (const s of far) this.drawPerson(ctx, s, dyn, t);
    ctx.drawImage(this.tableLayer, 0, 0);
    this.drawTableTop(ctx, dyn, t);
    for (const s of near) this.drawPerson(ctx, s, dyn, t);
  }

  // ------------------------------------------------------------------ dynamic pieces
  drawFloorMarks(ctx, s, dyn, t) {
    const selected = dyn.team?.has(s.id);
    const selectable = dyn.selectable?.has(s.id);
    if (!selected && !selectable) return;
    const rx = Math.round(0.24 * this.S * s.f);
    const ry = Math.max(3, Math.round(rx * TILT));
    ctx.fillStyle = selected ? '#5ec8ff' : 'rgba(255,255,255,0.35)';
    const steps = 44;
    const spin = selected ? t * 2 : 0;
    for (let k = 0; k < steps; k++) {
      const a = (k / steps) * TAU;
      if (!selected && k % 2) continue;
      if (selected && Math.sin(a * 2 + spin) < -0.6) continue;
      ctx.fillRect(Math.round(s.fx + Math.cos(a) * rx), Math.round(s.fy + Math.sin(a) * ry), 1, 1);
    }
  }

  drawTableTop(ctx, dyn, t) {
    // vote / quest cards in front of each player
    for (const s of this.seats) {
      const state = dyn.cards?.[s.id];
      if (!state) continue;
      const w = s.sideways ? 4 : 8;
      const h = s.sideways ? 7 : 4;
      const x = s.tokenX - (w >> 1);
      const y = s.tokenY - (h >> 1);
      const fills = {
        down: ['#2d3a6b', '#5c6fb8'],
        approve: ['#2f9e57', '#9af0b5'],
        reject: ['#b22a2a', '#ff9a9a'],
        success: ['#2e7bd6', '#a9d4ff'],
        fail: ['#b22a2a', '#ff9a9a'],
      }[state] || ['#444', '#888'];
      ctx.fillStyle = O;
      ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
      ctx.fillStyle = fills[0];
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = fills[1];
      ctx.fillRect(x + 1, y + 1, Math.max(1, w - 4), 1);
      if (state === 'down') {
        ctx.fillStyle = '#e0b84c';
        ctx.fillRect(x + (w >> 1) - 1, y + (h >> 1), 2, 1);
      }
    }

    // quest cards revealed in the middle
    const center = dyn.center;
    if (center && center.length) {
      const n = center.length;
      center.forEach((c, i) => {
        const a = (i / n) * TAU + 0.4;
        const p = this.project(Math.cos(a) * 0.42, 0, Math.sin(a) * 0.42);
        const x = Math.round(p.x) - 3;
        const y = Math.round(p.y) - 2;
        ctx.fillStyle = O;
        ctx.fillRect(x - 1, y - 1, 8, 6);
        ctx.fillStyle = c === 'fail' ? '#d83a3a' : '#3c8ee8';
        ctx.fillRect(x, y, 6, 4);
        ctx.fillStyle = c === 'fail' ? '#ffb3b3' : '#c7e3ff';
        ctx.fillRect(x + 1, y + 1, 4, 1);
      });
    }

    // candle
    const flick = Math.sin(t * 9) + Math.sin(t * 5.3);
    const cx = Math.round(this.cx);
    const cy = Math.round(this.cy);
    ctx.fillStyle = 'rgba(255,190,90,0.10)';
    this.fillEllipse(ctx, cx, cy, Math.round(this.S * 0.5), Math.round(this.S * 0.5 * TILT));
    ctx.fillStyle = 'rgba(255,190,90,0.12)';
    this.fillEllipse(ctx, cx, cy, Math.round(this.S * 0.3), Math.round(this.S * 0.3 * TILT));
    ctx.fillStyle = O;
    ctx.fillRect(cx - 3, cy - 8, 6, 9);
    ctx.fillStyle = '#efe6c8';
    ctx.fillRect(cx - 2, cy - 7, 4, 7);
    ctx.fillStyle = '#d6c9a0';
    ctx.fillRect(cx + 1, cy - 7, 1, 7);
    ctx.fillStyle = '#ffb347';
    ctx.fillRect(cx - 1, cy - 11 - (flick > 0.4 ? 1 : 0), 2, 3 + (flick > 0.4 ? 1 : 0));
    ctx.fillStyle = '#fff3b0';
    ctx.fillRect(cx - 1 + (flick > 1 ? 0 : 0), cy - 10, 1, 2);
  }

  fillEllipse(ctx, cx, cy, rx, ry) {
    for (let dy = -ry; dy <= ry; dy++) {
      const w = Math.round(rx * Math.sqrt(Math.max(0, 1 - (dy * dy) / (ry * ry))));
      ctx.fillRect(cx - w, cy + dy, w * 2 + 1, 1);
    }
  }

  drawPerson(ctx, s, dyn, t) {
    const p = this.players[s.i];
    const away = dyn.away?.has(s.id);
    const leader = dyn.leader === s.id;
    const picked = dyn.team?.has(s.id);
    const pending = dyn.pending?.has(s.id);
    const bob = Math.round(Math.sin(t * 2 + s.i * 1.7) * 0.6 + 0.4); // 0/1 px breathing
    const ox = s.sx - SPRITE_W / 2;
    const oy = s.sy - SPRITE_H - (away ? 0 : bob);
    const fh = Math.max(6, s.fy - s.sy);

    // floor shadow + chair
    ctx.fillStyle = 'rgba(0,0,0,0.32)';
    this.fillEllipse(ctx, s.fx, s.fy, 9, 3);
    this.drawChairLegs(ctx, s, fh);

    ctx.save();
    if (away) ctx.globalAlpha = 0.5;
    if (s.view !== 'back') this.drawChairBack(ctx, s, ox, oy);
    this.drawBody(ctx, s, ox, oy);
    if (s.view === 'back') this.drawChairBack(ctx, s, ox, oy);
    ctx.restore();

    // markers: stacked above the head, or beside it for far seats (their name tag sits above the head)
    const farSide = s.wz < 0;
    let top = oy - (p && s.look.style === 2 ? 8 : 2);
    if (leader) {
      this.drawCrown(ctx, s.sx, top - 4);
      top -= 8;
    }
    if (picked) {
      if (farSide) this.drawShield(ctx, s.sx + 15, oy + 1 + Math.round(Math.sin(t * 4)));
      else {
        this.drawShield(ctx, s.sx, top - 9 + Math.round(Math.sin(t * 4)));
        top -= 11;
      }
    }
    if (pending && !away) {
      const hop = Math.round(Math.abs(Math.sin(t * 5)) * 3);
      const ax = farSide ? s.sx - 15 : s.sx;
      const ay = farSide ? oy + 12 : top;
      ctx.fillStyle = O;
      ctx.fillRect(ax - 3, ay - 6 - hop, 7, 3);
      ctx.fillRect(ax - 2, ay - 3 - hop, 5, 2);
      ctx.fillRect(ax - 1, ay - 1 - hop, 3, 2);
      ctx.fillStyle = '#ffd23f';
      ctx.fillRect(ax - 2, ay - 5 - hop, 5, 1);
      ctx.fillRect(ax - 1, ay - 4 - hop, 3, 1);
      ctx.fillRect(ax, ay - 3 - hop, 1, 1);
    }
    if (away) this.drawZzz(ctx, s.sx + 7, oy - 2, t);
  }

  drawChairLegs(ctx, s, fh) {
    ctx.fillStyle = '#2a1a12';
    const lx = s.view === 'side' ? 5 : 7;
    ctx.fillRect(s.sx - lx, s.sy + 3, 2, fh - 3);
    ctx.fillRect(s.sx + lx - 2, s.sy + 3, 2, fh - 3);
    ctx.fillStyle = '#4a2f1e';
    ctx.fillRect(s.sx - lx - 1, s.sy, lx * 2 + 2, 3);
    ctx.fillStyle = '#6b4429';
    ctx.fillRect(s.sx - lx - 1, s.sy, lx * 2 + 2, 1);
  }

  drawChairBack(ctx, s, ox, oy) {
    const wood = '#5a3a24';
    const light = '#7a5233';
    if (s.view === 'back') {
      // backrest between camera and the person: covers the lower torso
      ctx.fillStyle = O;
      ctx.fillRect(ox - 1, oy + 15, SPRITE_W + 2, 8);
      ctx.fillStyle = wood;
      ctx.fillRect(ox, oy + 16, SPRITE_W, 6);
      ctx.fillStyle = light;
      ctx.fillRect(ox, oy + 16, SPRITE_W, 1);
      ctx.fillStyle = '#3d2616';
      for (let k = 2; k < SPRITE_W; k += 4) ctx.fillRect(ox + k, oy + 18, 1, 4);
    } else if (s.view === 'front') {
      ctx.fillStyle = O;
      ctx.fillRect(ox - 1, oy + 1, SPRITE_W + 2, SPRITE_H + 1);
      ctx.fillStyle = wood;
      ctx.fillRect(ox, oy + 2, SPRITE_W, SPRITE_H);
      ctx.fillStyle = light;
      ctx.fillRect(ox, oy + 2, SPRITE_W, 2);
    } else {
      const back = s.flip ? ox + SPRITE_W - 3 : ox - 1;
      ctx.fillStyle = O;
      ctx.fillRect(back - 1, oy + 4, 5, SPRITE_H - 2);
      ctx.fillStyle = wood;
      ctx.fillRect(back, oy + 5, 3, SPRITE_H - 4);
      ctx.fillStyle = light;
      ctx.fillRect(back, oy + 5, 1, SPRITE_H - 4);
    }
  }

  drawBody(ctx, s, ox, oy) {
    const L = s.look;
    const flip = s.flip;
    const R = (x, y, w, h, c) => {
      ctx.fillStyle = c;
      ctx.fillRect(flip ? ox + SPRITE_W - x - w : ox + x, oy + y, w, h);
    };
    const eye = '#1b1424';
    const view = s.view;

    if (view === 'side') {
      // torso
      R(3, 10, 10, 12, O);
      R(4, 11, 8, 11, L.robe);
      R(4, 11, 2, 11, L.robeShade);
      // arm reaching to the table
      R(8, 13, 4, 7, L.robeLight);
      R(10, 19, 4, 2, O);
      R(11, 19, 3, 1, L.skin);
      // head
      R(3, 1, 10, 10, O);
      R(4, 2, 8, 8, L.skin);
      R(12, 5, 2, 3, O);
      R(12, 5, 1, 3, L.skin);
      R(9, 5, 1, 2, eye);
      R(10, 8, 2, 1, '#a8433a');
      // hair on the back of the head
      R(4, 2, 8, 3, L.hair);
      R(4, 5, 4, L.style === 1 ? 7 : 3, L.hair);
      if (L.style === 2) this.hat(R, L);
      return;
    }

    // torso
    R(2, 10, 12, 12, O);
    R(3, 11, 10, 11, L.robe);
    R(11, 11, 2, 11, L.robeShade);
    R(3, 11, 1, 11, L.robeLight);
    ctx.clearRect(flip ? ox + SPRITE_W - 3 : ox + 2, oy + 10, 1, 1);

    if (view === 'front') {
      R(6, 11, 4, 1, L.robeLight);
      R(7, 12, 2, 1, L.robeLight);
      R(3, 19, 3, 2, L.skin);
      R(10, 19, 3, 2, L.skin);
      // head
      R(3, 1, 10, 10, O);
      R(4, 2, 8, 8, L.skin);
      R(6, 5, 1, 2, eye);
      R(9, 5, 1, 2, eye);
      R(7, 8, 2, 1, '#a8433a');
      R(5, 7, 1, 1, '#f0a090');
      R(10, 7, 1, 1, '#f0a090');
      R(4, 2, 8, 2, L.hair);
      R(4, 4, 1, 3, L.hair);
      R(11, 4, 1, 3, L.hair);
      R(5, 4, 3, 1, L.hair);
      R(9, 4, 2, 1, L.hair);
      if (L.style === 1) {
        R(3, 4, 2, 7, L.hair);
        R(11, 4, 2, 7, L.hair);
      }
      if (L.style === 2) this.hat(R, L);
      return;
    }

    // back
    R(7, 12, 2, 9, L.robeShade);
    R(3, 19, 3, 2, L.skin);
    R(10, 19, 3, 2, L.skin);
    R(3, 1, 10, 10, O);
    R(4, 2, 8, 8, L.hair);
    R(4, 7, 8, 3, shade(L.hair.startsWith('#') ? L.hair : '#000000', 0.8));
    R(5, 3, 3, 1, 'rgba(255,255,255,0.18)');
    if (L.style === 1) R(3, 8, 10, 3, L.hair);
    if (L.style === 2) this.hat(R, L);
  }

  hat(R, L) {
    R(2, 1, 12, 3, O);
    R(3, 2, 10, 1, L.hat);
    R(5, -1, 6, 3, O);
    R(6, -1, 4, 3, L.hat);
    R(6, -4, 4, 4, O);
    R(7, -4, 2, 4, L.hat);
    R(7, -7, 2, 4, O);
    R(7, -6, 1, 3, L.robeLight);
  }

  drawCrown(ctx, cx, y) {
    ctx.fillStyle = O;
    ctx.fillRect(cx - 5, y - 1, 11, 6);
    ctx.fillStyle = '#ffd23f';
    ctx.fillRect(cx - 4, y + 2, 9, 2);
    ctx.fillRect(cx - 4, y, 1, 2);
    ctx.fillRect(cx, y - 1, 1, 3);
    ctx.fillRect(cx + 4, y, 1, 2);
    ctx.fillStyle = '#e04a4a';
    ctx.fillRect(cx, y + 2, 1, 1);
  }

  drawShield(ctx, cx, y) {
    ctx.fillStyle = O;
    ctx.fillRect(cx - 4, y, 9, 8);
    ctx.fillRect(cx - 3, y + 8, 7, 1);
    ctx.fillRect(cx - 1, y + 9, 3, 1);
    ctx.fillStyle = '#4aa3ff';
    ctx.fillRect(cx - 3, y + 1, 7, 6);
    ctx.fillRect(cx - 2, y + 7, 5, 1);
    ctx.fillStyle = '#bfe1ff';
    ctx.fillRect(cx - 3, y + 1, 3, 3);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(cx, y + 2, 1, 4);
  }

  drawZzz(ctx, x, y, t) {
    const phase = (t * 0.8) % 1;
    const glyph = (gx, gy, sz) => {
      ctx.fillStyle = '#cfd8ff';
      ctx.fillRect(gx, gy, sz, 1);
      ctx.fillRect(gx + sz - 1, gy + 1, 1, 1);
      if (sz > 3) ctx.fillRect(gx + sz - 2, gy + 2, 1, 1);
      ctx.fillRect(gx, gy + sz - 1, sz, 1);
    };
    const lift = Math.round(phase * 5);
    glyph(x, y - lift, 3);
    glyph(x + 4, y - 5 - lift, 4);
  }

  // Pick the seat under a canvas-relative point (percent coords), for taps on the canvas itself.
  hitTest(fx, fy) {
    const px = fx * this.W;
    const py = fy * this.H;
    let best = null;
    let bestD = 18 * 18;
    for (const s of this.seats) {
      const d = (px - s.sx) ** 2 + (py - (s.sy - 10)) ** 2;
      if (d < bestD) {
        bestD = d;
        best = s.id;
      }
    }
    return best;
  }
}
