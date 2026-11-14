// Reads the toolpaths of a Bambu G-code so the app can draw the sliced result layer by layer
// (walls, infill, supports...) and show which filament prints each part.

/** Growing typed array (the number of segments is not known up front). */
class Buf {
  constructor(Type, per) {
    this.Type = Type;
    this.per = per;
    this.data = new Type(per * 4096);
    this.n = 0;
  }
  push(...v) {
    if ((this.n + 1) * this.per > this.data.length) {
      const next = new this.Type(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    for (let i = 0; i < this.per; i++) this.data[this.n * this.per + i] = v[i];
    this.n++;
  }
  done() {
    return this.data.slice(0, this.n * this.per);
  }
}

const NUM = /([XYZEIJ])(-?\d*\.?\d+)/g;

/**
 * Returns { count, pos (x0 y0 z0 x1 y1 z1 per segment), type, tool, layer, types[], layerZ[] }.
 * Segments come in print order, so every layer is a contiguous range.
 */
function parse(text, bed) {
  const pos = new Buf(Float32Array, 6);
  const type = new Buf(Uint8Array, 1);
  const tool = new Buf(Uint8Array, 1);
  const layer = new Buf(Uint16Array, 1);
  const types = [];
  const layerZ = [];

  let x = 0, y = 0, z = 0;
  let relative = false; // G91
  let relE = true; // M83 (Bambu default); M82 is absolute extrusion
  let e = 0;
  let cur = -1;
  let t = 0;
  let li = -1; // current layer index (-1: still in the start code)

  // Purge and wipe moves of tool changes happen outside the bed: they are not part of the print.
  const inside = (px, py) => !bed || (px >= -0.5 && py >= -0.5 && px <= bed.width + 0.5 && py <= bed.depth + 0.5);
  const emit = (x0, y0, z0, x1, y1, z1) => {
    if (li < 0 || !inside(x0, y0) || !inside(x1, y1)) return;
    pos.push(x0, y0, z0, x1, y1, z1);
    type.push(cur < 0 ? 0 : cur);
    tool.push(t);
    layer.push(li);
  };

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.charCodeAt(0) === 59 /* ; */) {
      if (line.startsWith('; FEATURE:')) {
        const name = line.slice(10).trim();
        let i = types.indexOf(name);
        if (i < 0) i = types.push(name) - 1;
        cur = i;
      } else if (line.startsWith('; CHANGE_LAYER')) {
        li++;
        layerZ.push(z);
      } else if (line.startsWith('; Z_HEIGHT:') && li >= 0) {
        const v = Number(line.slice(11));
        if (isFinite(v)) layerZ[li] = v;
      }
      continue;
    }
    const c = line[0];
    if (c === 'T') {
      const m = /^T(\d+)\s*(;.*)?$/.exec(line);
      if (m && Number(m[1]) < 64) t = Number(m[1]);
      continue;
    }
    if (c !== 'G') {
      if (line.startsWith('M83')) relE = true;
      else if (line.startsWith('M82')) relE = false;
      continue;
    }
    const code = /^G(\d+)/.exec(line)?.[1];
    if (code === '90') relative = false;
    else if (code === '91') relative = true;
    else if (code === '92') {
      const m = /E(-?\d*\.?\d+)/.exec(line);
      if (m) e = Number(m[1]);
    } else if (code === '0' || code === '1' || code === '2' || code === '3') {
      let nx = x, ny = y, nz = z, de = 0, hasE = false, I = 0, J = 0;
      const body = line.split(';')[0];
      NUM.lastIndex = 0;
      let m;
      while ((m = NUM.exec(body))) {
        const v = Number(m[2]);
        if (m[1] === 'X') nx = relative ? x + v : v;
        else if (m[1] === 'Y') ny = relative ? y + v : v;
        else if (m[1] === 'Z') nz = relative ? z + v : v;
        else if (m[1] === 'E') {
          hasE = true;
          de = relE ? v : v - e;
          e = relE ? e : v;
        } else if (m[1] === 'I') I = v;
        else if (m[1] === 'J') J = v;
      }
      if (hasE && de > 0 && !relative) {
        if (code === '2' || code === '3') {
          // Arc: draw it as short straight pieces.
          const cx = x + I, cy = y + J;
          const r = Math.hypot(I, J) || 1e-6;
          const a0 = Math.atan2(y - cy, x - cx);
          let a1 = Math.atan2(ny - cy, nx - cx);
          const cw = code === '2';
          if (cw) while (a1 >= a0 - 1e-9) a1 -= Math.PI * 2;
          else while (a1 <= a0 + 1e-9) a1 += Math.PI * 2;
          const steps = Math.max(2, Math.ceil((Math.abs(a1 - a0) * r) / 0.8));
          let px = x, py = y;
          for (let s = 1; s <= steps; s++) {
            const a = a0 + ((a1 - a0) * s) / steps;
            const qx = s === steps ? nx : cx + r * Math.cos(a);
            const qy = s === steps ? ny : cy + r * Math.sin(a);
            emit(px, py, nz, qx, qy, nz);
            px = qx;
            py = qy;
          }
        } else emit(x, y, z, nx, ny, nz);
      }
      x = nx;
      y = ny;
      z = nz;
    }
  }

  return { count: pos.n, pos: pos.done(), type: type.done(), tool: tool.done(), layer: layer.done(), types, layerZ };
}

module.exports = { parse };
