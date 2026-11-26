import * as THREE from 'three';

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export type VariableLoftOptions = {
  maxTriangleEdge?: number;
  subdivRounds?: number;
  wallRings?: number;
  rollSpan?: number;
  edgeFactor?: number;
  wallCrown?: number;
  zOffset?: number;
  halfWidthNegFn?: (x: number, y: number) => number;
  localMaxEdgeFn?: (x: number, y: number) => number;
};

function smoothstep(edge0: number, edge1: number, x: number): number {
  const span = edge1 - edge0;
  if (Math.abs(span) < 1e-8) return x >= edge0 ? 1 : 0;
  const t = Math.max(0, Math.min(1, (x - edge0) / span));
  return t * t * (3 - 2 * t);
}

function signedArea2D(loop: Vec2[]): number {
  let area = 0;
  for (let i = 0; i < loop.length; i += 1) {
    const [x0, y0] = loop[i];
    const [x1, y1] = loop[(i + 1) % loop.length];
    area += x0 * y1 - x1 * y0;
  }
  return area * 0.5;
}

/**
 * Deduplicates consecutive near-identical points, removes strictly collinear redundant points
 * (so Earcut never silently drops boundary points), and enforces winding (CCW outer, CW holes).
 */
function sanitizeLoop(raw: Vec2[], wantCCW: boolean): Vec2[] {
  const dedup: Vec2[] = [];
  for (const pt of raw) {
    if (dedup.length === 0) {
      dedup.push([pt[0], pt[1]]);
    } else {
      const prev = dedup[dedup.length - 1];
      if (Math.hypot(pt[0] - prev[0], pt[1] - prev[1]) > 1e-6) {
        dedup.push([pt[0], pt[1]]);
      }
    }
  }
  if (dedup.length > 2) {
    const first = dedup[0];
    const last = dedup[dedup.length - 1];
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) <= 1e-6) {
      dedup.pop();
    }
  }
  if (dedup.length < 3) return dedup;

  // Remove strictly collinear vertices so Earcut keeps 1-to-1 vertex correspondence
  const noCollinear: Vec2[] = [];
  const n = dedup.length;
  for (let i = 0; i < n; i += 1) {
    const prev = dedup[(i - 1 + n) % n];
    const curr = dedup[i];
    const next = dedup[(i + 1) % n];
    const ax = curr[0] - prev[0];
    const ay = curr[1] - prev[1];
    const bx = next[0] - curr[0];
    const by = next[1] - curr[1];
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    if (la < 1e-7 || lb < 1e-7) continue;
    const cross = Math.abs(ax * by - ay * bx) / (la * lb);
    const dot = (ax * bx + ay * by) / (la * lb);
    if (cross < 1e-5 && dot > 0) continue;
    noCollinear.push(curr);
  }
  const clean = noCollinear.length >= 3 ? noCollinear : dedup;

  const area = signedArea2D(clean);
  return (wantCCW && area < 0) || (!wantCCW && area > 0) ? [...clean].reverse() : clean;
}

function subdivideBoundaryLoop(loop: Vec2[], maxSegLen: number): Vec2[] {
  if (loop.length < 3 || maxSegLen <= 1e-5) return loop;
  const out: Vec2[] = [];
  const n = loop.length;
  for (let i = 0; i < n; i += 1) {
    const a = loop[i];
    const b = loop[(i + 1) % n];
    out.push([a[0], a[1]]);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.ceil(len / maxSegLen);
    if (steps > 1) {
      for (let s = 1; s < steps; s += 1) {
        const t = s / steps;
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
  }
  return out;
}

function triArea2D(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/**
 * Exact 2D inCircle determinant centered at vertex A (assuming A, B, C are CCW).
 * Returns < 0 when D lies strictly inside the circumcircle of (A, B, C).
 */
function inCircleDet(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): number {
  const bpx = bx - ax;
  const bpy = by - ay;
  const cpx = cx - ax;
  const cpy = cy - ay;
  const dpx = dx - ax;
  const dpy = dy - ay;
  const bp2 = bpx * bpx + bpy * bpy;
  const cp2 = cpx * cpx + cpy * cpy;
  const dp2 = dpx * dpx + dpy * dpy;

  const det =
    bpx * (cpy * dp2 - cp2 * dpy) -
    bpy * (cpx * dp2 - cp2 * dpx) +
    bp2 * (cpx * dpy - cpy * dpx);

  const scale = Math.max(
    Math.abs(bpx),
    Math.abs(bpy),
    Math.abs(cpx),
    Math.abs(cpy),
    Math.abs(dpx),
    Math.abs(dpy),
    1e-6,
  );
  return det / (scale * scale * scale * scale);
}

function flipNonDelaunayEdges(
  verts2D: Vec2[],
  tris: [number, number, number][],
  maxSweeps = 10,
): void {
  for (let sweep = 0; sweep < maxSweeps; sweep += 1) {
    const edgeToTri = new Map<string, { tIdx: number; opp: number }>();
    for (let t = 0; t < tris.length; t += 1) {
      const [a, b, c] = tris[t];
      edgeToTri.set(`${a}:${b}`, { tIdx: t, opp: c });
      edgeToTri.set(`${b}:${c}`, { tIdx: t, opp: a });
      edgeToTri.set(`${c}:${a}`, { tIdx: t, opp: b });
    }

    const dirtyTris = new Set<number>();
    let flips = 0;

    for (let t = 0; t < tris.length; t += 1) {
      if (dirtyTris.has(t)) continue;
      const tri = tris[t];
      const edges: [number, number, number][] = [
        [tri[0], tri[1], tri[2]],
        [tri[1], tri[2], tri[0]],
        [tri[2], tri[0], tri[1]],
      ];

      for (const [u, v, w] of edges) {
        if (u > v) continue;
        const twin = edgeToTri.get(`${v}:${u}`);
        if (!twin) continue;
        const t2 = twin.tIdx;
        if (t2 === t || dirtyTris.has(t2)) continue;
        const opp = twin.opp;

        const [ux, uy] = verts2D[u];
        const [vx, vy] = verts2D[v];
        const [wx, wy] = verts2D[w];
        const [ox, oy] = verts2D[opp];

        // New triangles (w, u, opp) and (w, opp, v) must remain strictly CCW
        if (triArea2D(wx, wy, ux, uy, ox, oy) <= 1e-11) continue;
        if (triArea2D(wx, wy, ox, oy, vx, vy) <= 1e-11) continue;

        if (inCircleDet(ux, uy, vx, vy, wx, wy, ox, oy) < -1e-7) {
          tris[t] = [w, u, opp];
          tris[t2] = [w, opp, v];
          dirtyTris.add(t);
          dirtyTris.add(t2);
          flips += 1;
          break;
        }
      }
    }

    if (flips === 0) break;
  }
}

function relaxInteriorVertices(
  verts2D: Vec2[],
  tris: [number, number, number][],
  rounds = 3,
): void {
  const directed = new Set<string>();
  for (const [a, b, c] of tris) {
    directed.add(`${a}:${b}`);
    directed.add(`${b}:${c}`);
    directed.add(`${c}:${a}`);
  }
  const boundaryVerts = new Set<number>();
  for (const [a, b, c] of tris) {
    if (!directed.has(`${b}:${a}`)) {
      boundaryVerts.add(a);
      boundaryVerts.add(b);
    }
    if (!directed.has(`${c}:${b}`)) {
      boundaryVerts.add(b);
      boundaryVerts.add(c);
    }
    if (!directed.has(`${a}:${c}`)) {
      boundaryVerts.add(c);
      boundaryVerts.add(a);
    }
  }

  for (let r = 0; r < rounds; r += 1) {
    const neighbors = new Map<number, Set<number>>();
    const incTris = new Map<number, number[]>();
    for (let t = 0; t < tris.length; t += 1) {
      const [a, b, c] = tris[t];
      for (const v of [a, b, c]) {
        if (!boundaryVerts.has(v)) {
          let arr = incTris.get(v);
          if (!arr) {
            arr = [];
            incTris.set(v, arr);
          }
          arr.push(t);
        }
      }
      for (const [u, v] of [
        [a, b],
        [b, c],
        [c, a],
      ]) {
        if (!boundaryVerts.has(u)) {
          let set = neighbors.get(u);
          if (!set) {
            set = new Set<number>();
            neighbors.set(u, set);
          }
          set.add(v);
        }
        if (!boundaryVerts.has(v)) {
          let set = neighbors.get(v);
          if (!set) {
            set = new Set<number>();
            neighbors.set(v, set);
          }
          set.add(u);
        }
      }
    }

    for (const [v, nbrSet] of neighbors.entries()) {
      if (nbrSet.size < 3) continue;
      let sx = 0;
      let sy = 0;
      for (const n of nbrSet) {
        sx += verts2D[n][0];
        sy += verts2D[n][1];
      }
      const cx = sx / nbrSet.size;
      const cy = sy / nbrSet.size;
      const [ox, oy] = verts2D[v];
      const nx = ox + 0.45 * (cx - ox);
      const ny = oy + 0.45 * (cy - oy);

      let valid = true;
      for (const tIdx of incTris.get(v) ?? []) {
        const [a, b, c] = tris[tIdx];
        const ax = a === v ? nx : verts2D[a][0];
        const ay = a === v ? ny : verts2D[a][1];
        const bx = b === v ? nx : verts2D[b][0];
        const by = b === v ? ny : verts2D[b][1];
        const cx2 = c === v ? nx : verts2D[c][0];
        const cy2 = c === v ? ny : verts2D[c][1];
        if (triArea2D(ax, ay, bx, by, cx2, cy2) <= 1e-11) {
          valid = false;
          break;
        }
      }
      if (valid) {
        verts2D[v] = [nx, ny];
      }
    }
  }
}

/**
 * Batch conforming edge-bisection on a 2D triangulation + Delaunay flipping & interior smoothing:
 * splits all edges longer than maxEdgeLen in synchronized batches (0 T-junctions) and removes
 * Earcut diagonal slivers so no long edges ever cross bevel/roll bands.
 */
function refineLongEdges(
  verts2D: Vec2[],
  tris: [number, number, number][],
  maxEdgeLen: number,
  maxTris = 9000,
  localMaxEdgeFn?: (x: number, y: number) => number,
): void {
  const edgeKey = (u: number, v: number) => (u < v ? `${u}:${v}` : `${v}:${u}`);

  for (let pass = 0; pass < 36; pass += 1) {
    if (tris.length >= maxTris) break;

    const longEdgeMap = new Map<string, { u: number; v: number; dSq: number }>();
    for (const [a, b, c] of tris) {
      for (const [u, v] of [
        [a, b],
        [b, c],
        [c, a],
      ] as [number, number][]) {
        const k = edgeKey(u, v);
        if (longEdgeMap.has(k)) continue;
        const dx = verts2D[u][0] - verts2D[v][0];
        const dy = verts2D[u][1] - verts2D[v][1];
        const dSq = dx * dx + dy * dy;
        const limit = localMaxEdgeFn
          ? Math.min(
              maxEdgeLen,
              localMaxEdgeFn(
                0.5 * (verts2D[u][0] + verts2D[v][0]),
                0.5 * (verts2D[u][1] + verts2D[v][1]),
              ),
            )
          : maxEdgeLen;
        if (dSq > limit * limit) {
          longEdgeMap.set(k, { u: Math.min(u, v), v: Math.max(u, v), dSq });
        }
      }
    }

    if (longEdgeMap.size === 0) break;

    let selected = Array.from(longEdgeMap.entries());
    const budget = Math.max(1, Math.floor((maxTris - tris.length) * 0.55));
    if (selected.length > budget) {
      selected.sort((a, b) => b[1].dSq - a[1].dSq);
      selected = selected.slice(0, budget);
    }

    const edgeMid = new Map<string, number>();
    for (const [k, { u, v }] of selected) {
      const midIdx = verts2D.length;
      verts2D.push([
        (verts2D[u][0] + verts2D[v][0]) * 0.5,
        (verts2D[u][1] + verts2D[v][1]) * 0.5,
      ]);
      edgeMid.set(k, midIdx);
    }

    const distSqIdx = (i: number, j: number) => {
      const dx = verts2D[i][0] - verts2D[j][0];
      const dy = verts2D[i][1] - verts2D[j][1];
      return dx * dx + dy * dy;
    };

    const splitTwo = (
      p0: number,
      p1: number,
      p2: number,
      m01: number,
      m20: number,
      out: [number, number, number][],
    ) => {
      out.push([p0, m01, m20]);
      if (distSqIdx(m01, p2) <= distSqIdx(p1, m20)) {
        out.push([m01, p1, p2], [m01, p2, m20]);
      } else {
        out.push([m01, p1, m20], [p1, p2, m20]);
      }
    };

    const nextTris: [number, number, number][] = [];
    for (const [a, b, c] of tris) {
      const mab = edgeMid.get(edgeKey(a, b));
      const mbc = edgeMid.get(edgeKey(b, c));
      const mca = edgeMid.get(edgeKey(c, a));
      const mask = (mab !== undefined ? 1 : 0) | (mbc !== undefined ? 2 : 0) | (mca !== undefined ? 4 : 0);

      if (mask === 7) {
        nextTris.push(
          [a, mab!, mca!],
          [mab!, b, mbc!],
          [mca!, mbc!, c],
          [mab!, mbc!, mca!],
        );
      } else if (mask === 5) {
        splitTwo(a, b, c, mab!, mca!, nextTris);
      } else if (mask === 3) {
        splitTwo(b, c, a, mbc!, mab!, nextTris);
      } else if (mask === 6) {
        splitTwo(c, a, b, mca!, mbc!, nextTris);
      } else if (mask === 1) {
        nextTris.push([a, mab!, c], [mab!, b, c]);
      } else if (mask === 2) {
        nextTris.push([b, mbc!, a], [mbc!, c, a]);
      } else if (mask === 4) {
        nextTris.push([c, mca!, b], [mca!, a, b]);
      } else {
        nextTris.push([a, b, c]);
      }
    }

    tris.length = 0;
    tris.push(...nextTris);
    if (pass % 2 === 1) {
      flipNonDelaunayEdges(verts2D, tris, 4);
    }
  }

  flipNonDelaunayEdges(verts2D, tris, 10);
  relaxInteriorVertices(verts2D, tris, 3);
  flipNonDelaunayEdges(verts2D, tris, 4);
}

/**
 * Extracts exact closed boundary half-edge loops directly from a manifold 2D triangle mesh.
 * Guarantees 100% 1-to-1 topological edge match between cap and wall (0 boundaryEdges).
 */
function extractBoundaryLoops(verts2D: Vec2[], tris: [number, number, number][]): number[][] {
  const directedSet = new Set<string>();
  const edgesList: [number, number][] = [];
  for (const [a, b, c] of tris) {
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ] as [number, number][]) {
      directedSet.add(`${u}:${v}`);
      edgesList.push([u, v]);
    }
  }

  const nextMap = new Map<number, number[]>();
  const boundaryPairs: [number, number][] = [];
  for (const [u, v] of edgesList) {
    if (!directedSet.has(`${v}:${u}`)) {
      boundaryPairs.push([u, v]);
      const arr = nextMap.get(u);
      if (arr) arr.push(v);
      else nextMap.set(u, [v]);
    }
  }

  const usedEdges = new Set<string>();
  const loops: number[][] = [];
  for (const [startU, startV] of boundaryPairs) {
    const startKey = `${startU}:${startV}`;
    if (usedEdges.has(startKey)) continue;

    const loop: number[] = [startU];
    usedEdges.add(startKey);
    let curr = startV;
    let guard = 0;
    while (curr !== startU && guard < 100000) {
      guard += 1;
      loop.push(curr);
      const candidates = nextMap.get(curr) ?? [];
      let picked = -1;
      for (const nxt of candidates) {
        const key = `${curr}:${nxt}`;
        if (!usedEdges.has(key)) {
          usedEdges.add(key);
          picked = nxt;
          break;
        }
      }
      if (picked < 0) break;
      curr = picked;
    }

    if (loop.length >= 3) {
      loops.push(loop);
    }
  }

  // Sort loops so outer CCW loop (largest positive area) comes first, followed by CW holes
  loops.sort((la, lb) => {
    const aa = signedArea2D(la.map((i) => verts2D[i]));
    const ab = signedArea2D(lb.map((i) => verts2D[i]));
    return ab - aa;
  });
  return loops;
}

function pointToSegmentDistSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-16) {
    const ex = px - ax;
    const ey = py - ay;
    return ex * ex + ey * ey;
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ex = px - cx;
  const ey = py - cy;
  return ex * ex + ey * ey;
}

function distToBoundarySegments(
  px: number,
  py: number,
  verts2D: Vec2[],
  loops: number[][],
): number {
  let minSq = Infinity;
  for (const loop of loops) {
    const n = loop.length;
    for (let i = 0; i < n; i += 1) {
      const a = verts2D[loop[i]];
      const b = verts2D[loop[(i + 1) % n]];
      const dSq = pointToSegmentDistSq(px, py, a[0], a[1], b[0], b[1]);
      if (dSq < minSq) minSq = dSq;
    }
  }
  return Math.sqrt(minSq);
}

/**
 * Computes unit-face-normal-averaged normals at welded 3D positions so corners between walls
 * and caps always bisect the exterior wedge cleanly (never pointing into incident faces).
 */
function computeWeldedUnitNormals(
  positions: number[],
  indices: number[],
): Float32Array {
  const vertCount = positions.length / 3;
  const keyOf = (i: number) =>
    `${Math.round(positions[i * 3] * 1e6)}_${Math.round(positions[i * 3 + 1] * 1e6)}_${Math.round(positions[i * 3 + 2] * 1e6)}`;

  const keys = new Array<string>(vertCount);
  const accum = new Map<string, [number, number, number]>();
  for (let i = 0; i < vertCount; i += 1) {
    const k = keyOf(i);
    keys[i] = k;
    if (!accum.has(k)) accum.set(k, [0, 0, 0]);
  }

  const pA = new THREE.Vector3();
  const pB = new THREE.Vector3();
  const pC = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const fn = new THREE.Vector3();

  for (let t = 0; t < indices.length; t += 3) {
    const ia = indices[t];
    const ib = indices[t + 1];
    const ic = indices[t + 2];
    pA.set(positions[ia * 3], positions[ia * 3 + 1], positions[ia * 3 + 2]);
    pB.set(positions[ib * 3], positions[ib * 3 + 1], positions[ib * 3 + 2]);
    pC.set(positions[ic * 3], positions[ic * 3 + 1], positions[ic * 3 + 2]);
    e1.subVectors(pB, pA);
    e2.subVectors(pC, pA);
    fn.crossVectors(e1, e2);
    const len = fn.length();
    if (len <= 1e-14) continue;
    fn.divideScalar(len); // unit face normal so narrow bevels weigh equally with wide faces!
    for (const idx of [ia, ib, ic]) {
      const acc = accum.get(keys[idx])!;
      acc[0] += fn.x;
      acc[1] += fn.y;
      acc[2] += fn.z;
    }
  }

  const out = new Float32Array(positions.length);
  for (let i = 0; i < vertCount; i += 1) {
    const acc = accum.get(keys[i])!;
    const len = Math.hypot(acc[0], acc[1], acc[2]) || 1;
    out[i * 3] = acc[0] / len;
    out[i * 3 + 1] = acc[1] / len;
    out[i * 3 + 2] = acc[2] / len;
  }
  return out;
}

/**
 * Variable-thickness 3D loft from a 2D XY outline and optional 2D holes.
 * Conforming edge-bisection + 4-way midpoint subdivision of cap faces, halfWidthFn(x,y)
 * sampling in +/-Z, exact topological boundary extraction (0 boundaryEdges), analytical
 * cap gradient normals, and welded unit-normal wall transitions (0 self-intersections).
 */
export function buildVariableLoft(
  outline2D: Vec2[],
  holes2D: Vec2[][],
  halfWidthFn: (x: number, y: number) => number,
  options: VariableLoftOptions = {},
): THREE.BufferGeometry {
  const maxTriangleEdge = options.maxTriangleEdge ?? 0.024;
  const subdivRounds = options.subdivRounds ?? 2;
  const wallRings = Math.max(5, options.wallRings ?? 11);
  const rollSpan = options.rollSpan ?? 0.008;
  const edgeFactor = options.edgeFactor ?? 0.80;
  const wallCrown = options.wallCrown ?? 0.0006;
  const zOffset = options.zOffset ?? 0;
  const halfWidthNegFn = options.halfWidthNegFn ?? halfWidthFn;
  const localMaxEdgeFn = options.localMaxEdgeFn;

  const boundaryStep = Math.max(0.004, maxTriangleEdge * 1.35);
  const outer = subdivideBoundaryLoop(sanitizeLoop(outline2D, true), boundaryStep);
  const holes = holes2D
    .map((h) => subdivideBoundaryLoop(sanitizeLoop(h, false), boundaryStep))
    .filter((h) => h.length >= 3);

  const allLoops: Vec2[][] = [outer, ...holes];
  const contourV2 = outer.map(([x, y]) => new THREE.Vector2(x, y));
  const holesV2 = holes.map((h) => h.map(([x, y]) => new THREE.Vector2(x, y)));

  const rawTris = THREE.ShapeUtils.triangulateShape(contourV2, holesV2);

  const verts2D: Vec2[] = [];
  for (const loop of allLoops) {
    for (const pt of loop) {
      verts2D.push([pt[0], pt[1]]);
    }
  }

  let tris: [number, number, number][] = [];
  for (const tri of rawTris) {
    const [a, b, c] = tri;
    if (a === undefined || b === undefined || c === undefined) continue;
    const [ax, ay] = verts2D[a];
    const [bx, by] = verts2D[b];
    const [cx, cy] = verts2D[c];
    const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(cross) < 1e-12) continue;
    tris.push(cross > 0 ? [a, b, c] : [a, c, b]);
  }

  // Break long slivers into compact triangles before 4-way subdivision
  refineLongEdges(verts2D, tris, maxTriangleEdge, localMaxEdgeFn ? 12000 : 9000, localMaxEdgeFn);

  // Uniform 4-way subdivision across all cap triangles (zero T-junctions)
  for (let round = 0; round < subdivRounds; round += 1) {
    const midCache = new Map<string, number>();
    const getMid = (u: number, v: number): number => {
      const key = u < v ? `${u}:${v}` : `${v}:${u}`;
      const existing = midCache.get(key);
      if (existing !== undefined) return existing;
      const idx = verts2D.length;
      verts2D.push([
        (verts2D[u][0] + verts2D[v][0]) * 0.5,
        (verts2D[u][1] + verts2D[v][1]) * 0.5,
      ]);
      midCache.set(key, idx);
      return idx;
    };

    const nextTris: [number, number, number][] = [];
    for (const [a, b, c] of tris) {
      const mab = getMid(a, b);
      const mbc = getMid(b, c);
      const mca = getMid(c, a);
      nextTris.push([a, mab, mca], [mab, b, mbc], [mca, mbc, c], [mab, mbc, mca]);
    }
    tris = nextTris;
  }

  // Extract EXACT cap boundary loops from final triangles (guarantees 0 boundaryEdges!)
  const boundaryLoops = extractBoundaryLoops(verts2D, tris);
  const boundarySet = new Set<number>();
  for (const loop of boundaryLoops) {
    for (const idx of loop) boundarySet.add(idx);
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of verts2D) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const spanX = Math.max(1e-5, maxX - minX);
  const spanY = Math.max(1e-5, maxY - minY);

  const evalZField = (x: number, y: number, sideIdx: 0 | 1, dBoundary?: number): number => {
    const fn = sideIdx === 0 ? halfWidthFn : halfWidthNegFn;
    const hw = Math.max(0.001, fn(x, y));
    const d = dBoundary !== undefined ? dBoundary : distToBoundarySegments(x, y, verts2D, boundaryLoops);
    const s = smoothstep(0, rollSpan, d);
    return hw * (edgeFactor + (1 - edgeFactor) * s);
  };

  // Precompute outward 2D normals and safe wall crown at every boundary vertex
  const boundaryNormals = new Map<number, Vec2>();
  const boundarySafeCrown = new Map<number, number>();
  for (let li = 0; li < boundaryLoops.length; li += 1) {
    const loop = boundaryLoops[li];
    const n = loop.length;
    const isOuter = li === 0;
    for (let i = 0; i < n; i += 1) {
      const idxPrev = loop[(i - 1 + n) % n];
      const idxCurr = loop[i];
      const idxNext = loop[(i + 1) % n];
      const [px, py] = verts2D[idxPrev];
      const [cx, cy] = verts2D[idxCurr];
      const [nx, ny] = verts2D[idxNext];

      const e1x = cx - px;
      const e1y = cy - py;
      const l1 = Math.hypot(e1x, e1y) || 1;
      const e2x = nx - cx;
      const e2y = ny - cy;
      const l2 = Math.hypot(e2x, e2y) || 1;

      const n1x = e1y / l1;
      const n1y = -e1x / l1;
      const n2x = e2y / l2;
      const n2y = -e2x / l2;

      let mx = n1x + n2x;
      let my = n1y + n2y;
      const mLen = Math.hypot(mx, my);
      if (mLen > 1e-6) {
        mx /= mLen;
        my /= mLen;
      } else {
        mx = n1x;
        my = n1y;
      }
      boundaryNormals.set(idxCurr, [mx, my]);

      const dotAdj = n1x * n2x + n1y * n2y;
      const crossTurn = (e1x * e2y - e1y * e2x) / (l1 * l2);
      const safe =
        isOuter && wallCrown > 0 && crossTurn >= -0.05 && dotAdj > 0.35
          ? Math.min(wallCrown, 0.14 * Math.min(l1, l2))
          : 0;
      boundarySafeCrown.set(idxCurr, safe);
    }
  }

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const analyticalCapNormals = new Map<number, Vec3>();

  const V = verts2D.length;
  const eps = 0.0005;

  for (let sideIdx = 0; sideIdx < 2; sideIdx += 1) {
    const sIdx = sideIdx as 0 | 1;
    const sign = sideIdx === 0 ? 1 : -1;
    const baseOffset = sideIdx * V;
    for (let i = 0; i < V; i += 1) {
      const [x, y] = verts2D[i];
      const isB = boundarySet.has(i);
      const zVal = evalZField(x, y, sIdx, isB ? 0 : undefined);
      positions.push(x, y, zOffset + sign * zVal);
      uvs.push((x - minX) / spanX, (y - minY) / spanY);

      if (!isB) {
        const fx = (evalZField(x + eps, y, sIdx) - evalZField(x - eps, y, sIdx)) / (2 * eps);
        const fy = (evalZField(x, y + eps, sIdx) - evalZField(x, y - eps, sIdx)) / (2 * eps);
        // Implicit outward surface is sign*z - evalZField(x, y) = 0 -> gradient is (-fx, -fy, sign)
        const nv = new THREE.Vector3(-fx, -fy, sign).normalize();
        analyticalCapNormals.set(baseOffset + i, [nv.x, nv.y, nv.z]);
      }
    }
  }

  for (const [a, b, c] of tris) {
    indices.push(a, b, c);
    indices.push(V + a, V + c, V + b);
  }

  // Multi-ring wall connecting +Z cap boundary and -Z cap boundary
  for (const loop of boundaryLoops) {
    const n = loop.length;
    const ringStart = new Array<number>(wallRings);

    for (let r = 0; r < wallRings; r += 1) {
      const phi = (r / (wallRings - 1)) * Math.PI;
      const t = Math.cos(phi);
      const alpha = 0.5 * (t + 1);
      const sinPhi = Math.sin(phi);
      ringStart[r] = positions.length / 3;

      for (let i = 0; i <= n; i += 1) {
        const vIdx = loop[i % n];
        const [x, y] = verts2D[vIdx];
        const [nx2, ny2] = boundaryNormals.get(vIdx) ?? [0, 0];
        const crown = boundarySafeCrown.get(vIdx) ?? 0;
        const edgeZPos = evalZField(x, y, 0, 0);
        const edgeZNeg = evalZField(x, y, 1, 0);
        const zVal = -edgeZNeg + alpha * (edgeZPos + edgeZNeg);

        const pushXY = r === 0 || r === wallRings - 1 ? 0 : crown * sinPhi;
        positions.push(x + nx2 * pushXY, y + ny2 * pushXY, zOffset + zVal);
        uvs.push(i / n, r / (wallRings - 1));
      }
    }

    for (let r = 0; r < wallRings - 1; r += 1) {
      const rHi = ringStart[r];
      const rLo = ringStart[r + 1];
      for (let i = 0; i < n; i += 1) {
        const aHi = rHi + i;
        const bHi = rHi + i + 1;
        const aLo = rLo + i;
        const bLo = rLo + i + 1;
        indices.push(aHi, aLo, bLo);
        indices.push(aHi, bLo, bHi);
      }
    }
  }

  // Compute exact welded geometric normals for walls/rims, preserving smooth analytical
  // gradient normals on interior cap vertices!
  const weldedNormals = computeWeldedUnitNormals(positions, indices);
  for (const [idx, nVec] of analyticalCapNormals.entries()) {
    weldedNormals[idx * 3] = nVec[0];
    weldedNormals[idx * 3 + 1] = nVec[1];
    weldedNormals[idx * 3 + 2] = nVec[2];
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(weldedNormals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

export type LatheProfileOptions = {
  axis?: 'x' | 'y' | 'z';
  segments?: number;
  capStart?: boolean;
  capEnd?: boolean;
  center?: Vec3;
  squashZ?: number;
  squashY?: number;
  maxAxialStep?: number;
};

/**
 * Watertight revolved profile built explicitly without zero-area pole quads,
 * subdividing long axial spans and computing unit-face-normal-averaged normals
 * so stepped shoulders never create grazing ray-parity errors.
 */
export function buildLatheProfile(
  points: [number, number][],
  options: LatheProfileOptions = {},
): THREE.BufferGeometry {
  const axis = options.axis ?? 'x';
  const segments = Math.max(8, options.segments ?? 32);
  const capStart = options.capStart ?? true;
  const capEnd = options.capEnd ?? true;
  const center = options.center ?? [0, 0, 0];
  const squashY = options.squashY ?? 1;
  const squashZ = options.squashZ ?? 1;
  const maxAxialStep = options.maxAxialStep ?? 0.015;

  const baseOrdered =
    points.length >= 2 && points[points.length - 1][0] < points[0][0]
      ? [...points].reverse()
      : [...points];

  // Subdivide long axial spans so no triangle spans far along the shaft
  const ordered: [number, number][] = [];
  for (let i = 0; i < baseOrdered.length; i += 1) {
    const [a0, r0] = baseOrdered[i];
    ordered.push([a0, r0]);
    if (i < baseOrdered.length - 1) {
      const [a1, r1] = baseOrdered[i + 1];
      const span = Math.abs(a1 - a0);
      const steps = Math.max(1, Math.ceil(span / maxAxialStep));
      for (let s = 1; s < steps; s += 1) {
        const t = s / steps;
        ordered.push([a0 + (a1 - a0) * t, r0 + (r1 - r0) * t]);
      }
    }
  }

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const minAxial = ordered[0][0];
  const maxAxial = ordered[ordered.length - 1][0];
  const axialSpan = Math.max(1e-5, maxAxial - minAxial);

  const pushPoint = (axial: number, uCoord: number, vCoord: number) => {
    let lx = 0;
    let ly = 0;
    let lz = 0;
    if (axis === 'x') {
      lx = axial;
      ly = uCoord * squashY;
      lz = vCoord * squashZ;
    } else if (axis === 'y') {
      lx = uCoord * squashY;
      ly = axial;
      lz = vCoord * squashZ;
    } else {
      lx = uCoord * squashY;
      ly = vCoord * squashZ;
      lz = axial;
    }
    positions.push(center[0] + lx, center[1] + ly, center[2] + lz);
  };

  const ringStarts: number[] = [];
  for (let p = 0; p < ordered.length; p += 1) {
    const [axial, rawR] = ordered[p];
    const r = Math.max(1e-5, rawR);
    ringStarts.push(positions.length / 3);
    const vUv = (axial - minAxial) / axialSpan;
    for (let s = 0; s <= segments; s += 1) {
      const theta = (s / segments) * Math.PI * 2;
      const c = Math.cos(theta) * r;
      const sn = Math.sin(theta) * r;
      if (axis === 'x') {
        pushPoint(axial, c, sn);
      } else if (axis === 'y') {
        pushPoint(axial, sn, c);
      } else {
        pushPoint(axial, c, sn);
      }
      uvs.push(s / segments, vUv);
    }
  }

  for (let p = 0; p < ordered.length - 1; p += 1) {
    const r0 = ringStarts[p];
    const r1 = ringStarts[p + 1];
    for (let s = 0; s < segments; s += 1) {
      const a0 = r0 + s;
      const b0 = r0 + s + 1;
      const a1 = r1 + s;
      const b1 = r1 + s + 1;
      indices.push(a0, b0, b1);
      indices.push(a0, b1, a1);
    }
  }

  if (capStart) {
    const startPole = positions.length / 3;
    pushPoint(ordered[0][0], 0, 0);
    uvs.push(0.5, 0);
    const r0 = ringStarts[0];
    for (let s = 0; s < segments; s += 1) {
      indices.push(startPole, r0 + s + 1, r0 + s);
    }
  }

  if (capEnd) {
    const endPole = positions.length / 3;
    pushPoint(ordered[ordered.length - 1][0], 0, 0);
    uvs.push(0.5, 1);
    const rLast = ringStarts[ringStarts.length - 1];
    for (let s = 0; s < segments; s += 1) {
      indices.push(endPole, rLast + s, rLast + s + 1);
    }
  }

  const weldedNormals = computeWeldedUnitNormals(positions, indices);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(weldedNormals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

export type TaperedTubeOptions = {
  steps?: number;
  radialSegments?: number;
  closed?: boolean;
  capEnds?: boolean;
  aspectZ?: number;
};

/**
 * Parallel-transport (Bishop frame) tapered tube along a 3D spline.
 */
export function buildTaperedTube(
  spine3D: Vec3[],
  radiusFn: (t: number) => number | [number, number],
  options: TaperedTubeOptions = {},
): THREE.BufferGeometry {
  const closed = options.closed ?? false;
  const steps = Math.max(8, options.steps ?? spine3D.length * 8);
  const radialSegments = Math.max(6, options.radialSegments ?? 16);
  const capEnds = !closed && (options.capEnds ?? true);
  const aspectZ = options.aspectZ ?? 1;

  const curve = new THREE.CatmullRomCurve3(
    spine3D.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
    closed,
  );

  const points: THREE.Vector3[] = [];
  const tangents: THREE.Vector3[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    points.push(curve.getPointAt(t));
    tangents.push(curve.getTangentAt(t).normalize());
  }

  const normalsFrame: THREE.Vector3[] = [];
  const binormalsFrame: THREE.Vector3[] = [];
  const t0 = tangents[0];
  const refUp = Math.abs(t0.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const n0 = new THREE.Vector3().crossVectors(t0, refUp).normalize();
  const b0 = new THREE.Vector3().crossVectors(t0, n0).normalize();
  normalsFrame.push(n0);
  binormalsFrame.push(b0);

  for (let i = 1; i <= steps; i += 1) {
    const prevT = tangents[i - 1];
    const currT = tangents[i];
    const prevN = normalsFrame[i - 1].clone();
    const rotAxis = new THREE.Vector3().crossVectors(prevT, currT);
    const sinA = rotAxis.length();
    if (sinA > 1e-6) {
      rotAxis.divideScalar(sinA);
      const angle = Math.atan2(sinA, prevT.dot(currT));
      prevN.applyAxisAngle(rotAxis, angle);
    }
    prevN.addScaledVector(currT, -prevN.dot(currT)).normalize();
    const currB = new THREE.Vector3().crossVectors(currT, prevN).normalize();
    normalsFrame.push(prevN);
    binormalsFrame.push(currB);
  }

  // Distribute holonomy twist evenly on closed loops so ring[steps] matches ring[0] seamlessly
  if (closed && steps > 0) {
    const tEnd = tangents[steps];
    const nStart = normalsFrame[0];
    const nEnd = normalsFrame[steps];
    const cosA = Math.max(-1, Math.min(1, nEnd.dot(nStart)));
    const sinA = new THREE.Vector3().crossVectors(nEnd, nStart).dot(tEnd);
    const totalTwist = Math.atan2(sinA, cosA);
    if (Math.abs(totalTwist) > 1e-6) {
      for (let i = 0; i <= steps; i += 1) {
        const ang = (i / steps) * totalTwist;
        normalsFrame[i].applyAxisAngle(tangents[i], ang).normalize();
        binormalsFrame[i].crossVectors(tangents[i], normalsFrame[i]).normalize();
      }
    }
  }

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const ringStarts: number[] = [];

  for (let i = 0; i <= steps; i += 1) {
    const isClosedEnd = closed && i === steps;
    const t = isClosedEnd ? 0 : i / steps;
    const p = isClosedEnd ? points[0] : points[i];
    const nVec = isClosedEnd ? normalsFrame[0] : normalsFrame[i];
    const bVec = isClosedEnd ? binormalsFrame[0] : binormalsFrame[i];
    const rawRad = radiusFn(t);
    const rn = Array.isArray(rawRad) ? Math.max(1e-5, rawRad[0]) : Math.max(1e-5, rawRad);
    const rb = Array.isArray(rawRad) ? Math.max(1e-5, rawRad[1]) : Math.max(1e-5, rawRad * aspectZ);

    ringStarts.push(positions.length / 3);
    for (let s = 0; s <= radialSegments; s += 1) {
      const theta = (s / radialSegments) * Math.PI * 2;
      const cosT = Math.cos(theta) * rn;
      const sinT = Math.sin(theta) * rb;
      positions.push(
        p.x + nVec.x * cosT + bVec.x * sinT,
        p.y + nVec.y * cosT + bVec.y * sinT,
        p.z + nVec.z * cosT + bVec.z * sinT,
      );
      uvs.push(s / radialSegments, i / steps);
    }
  }

  for (let i = 0; i < steps; i += 1) {
    const r0 = ringStarts[i];
    const r1 = ringStarts[i + 1];
    for (let s = 0; s < radialSegments; s += 1) {
      const a0 = r0 + s;
      const b0 = r0 + s + 1;
      const a1 = r1 + s;
      const b1 = r1 + s + 1;
      indices.push(a0, b0, b1);
      indices.push(a0, b1, a1);
    }
  }

  if (capEnds) {
    const pStart = points[0];
    const startPole = positions.length / 3;
    positions.push(pStart.x, pStart.y, pStart.z);
    uvs.push(0.5, 0);
    const r0 = ringStarts[0];
    for (let s = 0; s < radialSegments; s += 1) {
      indices.push(startPole, r0 + s + 1, r0 + s);
    }

    const pEnd = points[steps];
    const endPole = positions.length / 3;
    positions.push(pEnd.x, pEnd.y, pEnd.z);
    uvs.push(0.5, 1);
    const rLast = ringStarts[steps];
    for (let s = 0; s < radialSegments; s += 1) {
      indices.push(endPole, rLast + s, rLast + s + 1);
    }
  }

  const weldedNormals = computeWeldedUnitNormals(positions, indices);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(weldedNormals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

export type TransverseXStation = {
  x: number;
  profileYZ: Vec2[]; // [y, z] pairs around cross-section perimeter
};

export type TransverseXLoftOptions = {
  endCapBevel?: number;
  capStart?: boolean;
  capEnd?: boolean;
};

/**
 * Builds a watertight solid by lofting YZ cross-section rings strictly along +X.
 * Every longitudinal edge runs 100% parallel to X so machined receiver flutes and chamfers
 * never suffer from diagonal Earcut triangle slivers across grooves.
 */
export function buildTransverseXLoft(
  rawStations: TransverseXStation[],
  options: TransverseXLoftOptions = {},
): THREE.BufferGeometry {
  const capStart = options.capStart ?? true;
  const capEnd = options.capEnd ?? true;
  const endCapBevel = options.endCapBevel ?? 0.0006;

  if (rawStations.length < 2) {
    throw new Error('buildTransverseXLoft requires at least 2 stations');
  }

  const sorted = [...rawStations].sort((a, b) => a.x - b.x);
  const M = sorted[0].profileYZ.length;
  for (const st of sorted) {
    if (st.profileYZ.length !== M) {
      throw new Error('All stations in buildTransverseXLoft must have identical profile length');
    }
  }

  // Ensure CCW winding in (Y, Z) plane (positive signed area sum(y_j * z_{j+1} - y_{j+1} * z_j))
  const midSt = sorted[Math.floor(sorted.length / 2)].profileYZ;
  let areaYZ = 0;
  for (let j = 0; j < M; j += 1) {
    const [y0, z0] = midSt[j];
    const [y1, z1] = midSt[(j + 1) % M];
    areaYZ += y0 * z1 - y1 * z0;
  }
  const stations: TransverseXStation[] = sorted.map((st) => ({
    x: st.x,
    profileYZ: areaYZ >= 0 ? st.profileYZ.map((p) => [p[0], p[1]]) : [...st.profileYZ].reverse().map((p) => [p[0], p[1]]),
  }));

  // Optionally insert crisp chamfer rings at start and end caps
  const finalStations: TransverseXStation[] = [];
  const makeShrunk = (st: TransverseXStation, xNew: number, shrink: number): TransverseXStation => {
    let yc = 0;
    let zc = 0;
    for (const [y, z] of st.profileYZ) {
      yc += y;
      zc += z;
    }
    yc /= M;
    zc /= M;
    return {
      x: xNew,
      profileYZ: st.profileYZ.map(([y, z]) => {
        const dy = y - yc;
        const dz = z - zc;
        const len = Math.hypot(dy, dz) || 1;
        const s = Math.max(0.25, (len - shrink) / len);
        return [yc + dy * s, zc + dz * s];
      }),
    };
  };

  if (capStart && endCapBevel > 0 && stations[1].x - stations[0].x > endCapBevel * 3) {
    finalStations.push(makeShrunk(stations[0], stations[0].x, endCapBevel));
    finalStations.push({ x: stations[0].x + endCapBevel, profileYZ: stations[0].profileYZ });
  } else {
    finalStations.push(stations[0]);
  }

  for (let i = 1; i < stations.length - 1; i += 1) {
    finalStations.push(stations[i]);
  }

  const lastIdx = stations.length - 1;
  if (capEnd && endCapBevel > 0 && stations[lastIdx].x - stations[lastIdx - 1].x > endCapBevel * 3) {
    finalStations.push({ x: stations[lastIdx].x - endCapBevel, profileYZ: stations[lastIdx].profileYZ });
    finalStations.push(makeShrunk(stations[lastIdx], stations[lastIdx].x, endCapBevel));
  } else {
    finalStations.push(stations[lastIdx]);
  }

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const minX = finalStations[0].x;
  const maxX = finalStations[finalStations.length - 1].x;
  const spanX = Math.max(1e-5, maxX - minX);

  const ringStarts: number[] = [];
  for (let i = 0; i < finalStations.length; i += 1) {
    const st = finalStations[i];
    const u = (st.x - minX) / spanX;
    ringStarts.push(positions.length / 3);
    for (let j = 0; j <= M; j += 1) {
      const [y, z] = st.profileYZ[j % M];
      positions.push(st.x, y, z);
      uvs.push(u, j / M);
    }
  }

  for (let i = 0; i < finalStations.length - 1; i += 1) {
    const r0 = ringStarts[i];
    const r1 = ringStarts[i + 1];
    for (let j = 0; j < M; j += 1) {
      const a = r0 + j;
      const b = r1 + j;
      const c = r1 + j + 1;
      const d = r0 + j + 1;
      indices.push(a, d, c);
      indices.push(a, c, b);
    }
  }

  const centroidOf = (prof: Vec2[]): [number, number] => {
    let sy = 0;
    let sz = 0;
    for (const [y, z] of prof) {
      sy += y;
      sz += z;
    }
    return [sy / prof.length, sz / prof.length];
  };

  if (capStart) {
    const [yc, zc] = centroidOf(finalStations[0].profileYZ);
    const startPole = positions.length / 3;
    positions.push(finalStations[0].x, yc, zc);
    uvs.push(0, 0.5);
    const r0 = ringStarts[0];
    for (let j = 0; j < M; j += 1) {
      indices.push(startPole, r0 + j + 1, r0 + j);
    }
  }

  if (capEnd) {
    const last = finalStations.length - 1;
    const [yc, zc] = centroidOf(finalStations[last].profileYZ);
    const endPole = positions.length / 3;
    positions.push(finalStations[last].x, yc, zc);
    uvs.push(1, 0.5);
    const rLast = ringStarts[last];
    for (let j = 0; j < M; j += 1) {
      indices.push(endPole, rLast + j, rLast + j + 1);
    }
  }

  const weldedNormals = computeWeldedUnitNormals(positions, indices);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(weldedNormals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Chamfered rectangular prism built via variable-thickness lofting (never an 8-vertex slab).
 */
export function buildChamferedBox(
  center: Vec3,
  size: Vec3,
  chamfer = 0.002,
  wallRings = 7,
): THREE.BufferGeometry {
  const [cx, cy, cz] = center;
  const hx = Math.max(0.001, size[0] * 0.5);
  const hy = Math.max(0.001, size[1] * 0.5);
  const hz = Math.max(0.001, size[2] * 0.5);
  const ch = Math.min(chamfer, hx * 0.4, hy * 0.4, hz * 0.4);

  const outline: Vec2[] = [
    [cx - hx + ch, cy - hy],
    [cx + hx - ch, cy - hy],
    [cx + hx, cy - hy + ch],
    [cx + hx, cy + hy - ch],
    [cx + hx - ch, cy + hy],
    [cx - hx + ch, cy + hy],
    [cx - hx, cy + hy - ch],
    [cx - hx, cy - hy + ch],
  ];

  return buildVariableLoft(outline, [], () => hz, {
    maxTriangleEdge: Math.max(0.018, Math.min(hx, hy) * 1.5),
    subdivRounds: 0,
    wallRings,
    rollSpan: Math.max(0.0022, ch * 1.6),
    edgeFactor: 0.90,
    wallCrown: 0,
    zOffset: cz,
  });
}

/**
 * Watertight 26-face chamfered cuboid with split planar/bevel normals (zero pyramidal <|> shading
 * on flat faces) and quantized shared boundary edges (0 boundary/non-manifold edges).
 */
export function buildSharpChamferedBox(
  center: Vec3,
  size: Vec3,
  chamfer = 0.001,
  wallRingsZ = 12,
  faceSubdivs = 3,
): THREE.BufferGeometry {
  const [cx, cy, cz] = center;
  const hx = Math.max(0.0005, size[0] * 0.5);
  const hy = Math.max(0.0005, size[1] * 0.5);
  const hz = Math.max(0.0005, size[2] * 0.5);
  const ch = Math.min(Math.max(0.00015, chamfer), hx * 0.38, hy * 0.38, hz * 0.38);

  const ix = hx - ch;
  const iy = hy - ch;
  const iz = hz - ch;

  const nx = Math.max(1, faceSubdivs);
  const ny = Math.max(1, faceSubdivs);
  const nz = Math.max(2, wallRingsZ);

  const linspace = (a: number, b: number, n: number): number[] => {
    const arr = new Array<number>(n + 1);
    for (let i = 0; i <= n; i += 1) {
      arr[i] = a + ((b - a) * i) / n;
    }
    return arr;
  };

  const xs = linspace(-ix, ix, nx);
  const ys = linspace(-iy, iy, ny);
  const zs = linspace(-iz, iz, nz);

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const pushTri = (ia: number, ib: number, ic: number, outN: Vec3) => {
    const ax = positions[ia * 3];
    const ay = positions[ia * 3 + 1];
    const az = positions[ia * 3 + 2];
    const e1x = positions[ib * 3] - ax;
    const e1y = positions[ib * 3 + 1] - ay;
    const e1z = positions[ib * 3 + 2] - az;
    const e2x = positions[ic * 3] - ax;
    const e2y = positions[ic * 3 + 1] - ay;
    const e2z = positions[ic * 3 + 2] - az;
    const nx0 = e1y * e2z - e1z * e2y;
    const ny0 = e1z * e2x - e1x * e2z;
    const nz0 = e1x * e2y - e1y * e2x;
    if (nx0 * outN[0] + ny0 * outN[1] + nz0 * outN[2] >= 0) {
      indices.push(ia, ib, ic);
    } else {
      indices.push(ia, ic, ib);
    }
  };

  const emitGrid = (
    uN: number,
    vN: number,
    ptFn: (iu: number, iv: number) => Vec3,
    nVec: Vec3,
  ) => {
    const len = Math.hypot(nVec[0], nVec[1], nVec[2]) || 1;
    const nn: Vec3 = [nVec[0] / len, nVec[1] / len, nVec[2] / len];
    const base = positions.length / 3;
    for (let iu = 0; iu <= uN; iu += 1) {
      for (let iv = 0; iv <= vN; iv += 1) {
        const [lx, ly, lz] = ptFn(iu, iv);
        positions.push(cx + lx, cy + ly, cz + lz);
        normals.push(nn[0], nn[1], nn[2]);
        uvs.push(iu / uN, iv / vN);
      }
    }
    for (let iu = 0; iu < uN; iu += 1) {
      for (let iv = 0; iv < vN; iv += 1) {
        const a = base + iu * (vN + 1) + iv;
        const b = base + (iu + 1) * (vN + 1) + iv;
        const c = base + (iu + 1) * (vN + 1) + (iv + 1);
        const d = base + iu * (vN + 1) + (iv + 1);
        pushTri(a, b, c, nn);
        pushTri(a, c, d, nn);
      }
    }
  };

  // 6 planar faces
  for (const sz of [-1, 1] as const) {
    emitGrid(nx, ny, (iu, iv) => [xs[iu], ys[iv], sz * hz], [0, 0, sz]);
  }
  for (const sx of [-1, 1] as const) {
    emitGrid(ny, nz, (iu, iv) => [sx * hx, ys[iu], zs[iv]], [sx, 0, 0]);
  }
  for (const sy of [-1, 1] as const) {
    emitGrid(nx, nz, (iu, iv) => [xs[iu], sy * hy, zs[iv]], [0, sy, 0]);
  }

  // 12 45-degree chamfer strips matching edge subdivisions 1-to-1
  for (const sy of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      emitGrid(
        nx,
        1,
        (iu, iv) => [xs[iu], iv === 0 ? sy * iy : sy * hy, iv === 0 ? sz * hz : sz * iz],
        [0, sy, sz],
      );
    }
  }
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      emitGrid(
        ny,
        1,
        (iu, iv) => [iv === 0 ? sx * ix : sx * hx, ys[iu], iv === 0 ? sz * hz : sz * iz],
        [sx, 0, sz],
      );
    }
  }
  for (const sx of [-1, 1] as const) {
    for (const sy of [-1, 1] as const) {
      emitGrid(
        nz,
        1,
        (iu, iv) => [iv === 0 ? sx * hx : sx * ix, iv === 0 ? sy * iy : sy * hy, zs[iu]],
        [sx, sy, 0],
      );
    }
  }

  // 8 corner bevel triangles
  for (const sx of [-1, 1] as const) {
    for (const sy of [-1, 1] as const) {
      for (const sz of [-1, 1] as const) {
        const s3 = Math.SQRT1_2 * Math.sqrt(2 / 3);
        const nn: Vec3 = [sx * s3, sy * s3, sz * s3];
        const base = positions.length / 3;
        positions.push(
          cx + sx * ix, cy + sy * iy, cz + sz * hz,
          cx + sx * hx, cy + sy * iy, cz + sz * iz,
          cx + sx * ix, cy + sy * hy, cz + sz * iz,
        );
        for (let k = 0; k < 3; k += 1) {
          normals.push(nn[0], nn[1], nn[2]);
          uvs.push(k === 1 ? 1 : 0, k === 2 ? 1 : 0);
        }
        pushTri(base, base + 1, base + 2, nn);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

export type GroupedGeometryPart = {
  geo: THREE.BufferGeometry;
  materialIndex: number;
};

export function mergeGeometriesGrouped(parts: GroupedGeometryPart[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const uv1s: number[] = [];
  const wearAOs: number[] = [];
  const indices: number[] = [];
  const groups: { start: number; count: number; materialIndex: number }[] = [];

  const anyHasUv1 = parts.some((p) => Boolean(p.geo.getAttribute('uv1')));
  const anyHasWear = parts.some((p) => Boolean(p.geo.getAttribute('aWearAO')));

  for (const part of parts) {
    const geo = part.geo;
    const pos = geo.getAttribute('position');
    if (!pos) continue;
    let norm = geo.getAttribute('normal');
    if (!norm) {
      geo.computeVertexNormals();
      norm = geo.getAttribute('normal');
    }
    const uv = geo.getAttribute('uv');
    const uv1 = geo.getAttribute('uv1');
    const wear = geo.getAttribute('aWearAO');
    const baseIndex = positions.length / 3;
    const startIdx = indices.length;

    for (let i = 0; i < pos.count; i += 1) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      if (norm) {
        normals.push(norm.getX(i), norm.getY(i), norm.getZ(i));
      } else {
        normals.push(0, 1, 0);
      }
      if (uv) {
        uvs.push(uv.getX(i), uv.getY(i));
      } else {
        uvs.push(0, 0);
      }
      if (anyHasUv1) {
        if (uv1) {
          uv1s.push(uv1.getX(i), uv1.getY(i));
        } else {
          uv1s.push(0, 0);
        }
      }
      if (anyHasWear) {
        if (wear) {
          wearAOs.push(wear.getX(i), wear.getY(i), wear.getZ(i));
        } else {
          wearAOs.push(0, 1, 0);
        }
      }
    }

    if (geo.index) {
      const idx = geo.index;
      for (let i = 0; i < idx.count; i += 1) {
        indices.push(baseIndex + idx.getX(i));
      }
    } else {
      for (let i = 0; i < pos.count; i += 1) {
        indices.push(baseIndex + i);
      }
    }

    const count = indices.length - startIdx;
    if (count > 0) {
      groups.push({ start: startIdx, count, materialIndex: part.materialIndex });
    }
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  merged.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  if (anyHasUv1) {
    merged.setAttribute('uv1', new THREE.Float32BufferAttribute(uv1s, 2));
  }
  if (anyHasWear) {
    merged.setAttribute('aWearAO', new THREE.Float32BufferAttribute(wearAOs, 3));
  }
  merged.setIndex(indices);
  for (const g of groups) {
    merged.addGroup(g.start, g.count, g.materialIndex);
  }
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

export function mergeGeometries(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const uv1s: number[] = [];
  const wearAOs: number[] = [];
  const indices: number[] = [];

  const anyHasUv1 = geos.some((g) => Boolean(g.getAttribute('uv1')));
  const anyHasWear = geos.some((g) => Boolean(g.getAttribute('aWearAO')));

  for (const geo of geos) {
    const pos = geo.getAttribute('position');
    if (!pos) continue;
    let norm = geo.getAttribute('normal');
    if (!norm) {
      geo.computeVertexNormals();
      norm = geo.getAttribute('normal');
    }
    const uv = geo.getAttribute('uv');
    const uv1 = geo.getAttribute('uv1');
    const wear = geo.getAttribute('aWearAO');
    const baseIndex = positions.length / 3;

    for (let i = 0; i < pos.count; i += 1) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      if (norm) {
        normals.push(norm.getX(i), norm.getY(i), norm.getZ(i));
      } else {
        normals.push(0, 1, 0);
      }
      if (uv) {
        uvs.push(uv.getX(i), uv.getY(i));
      } else {
        uvs.push(0, 0);
      }
      if (anyHasUv1) {
        if (uv1) {
          uv1s.push(uv1.getX(i), uv1.getY(i));
        } else {
          uv1s.push(0, 0);
        }
      }
      if (anyHasWear) {
        if (wear) {
          wearAOs.push(wear.getX(i), wear.getY(i), wear.getZ(i));
        } else {
          wearAOs.push(0, 1, 0);
        }
      }
    }

    if (geo.index) {
      const idx = geo.index;
      for (let i = 0; i < idx.count; i += 1) {
        indices.push(baseIndex + idx.getX(i));
      }
    } else {
      for (let i = 0; i < pos.count; i += 1) {
        indices.push(baseIndex + i);
      }
    }
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  merged.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  if (anyHasUv1) {
    merged.setAttribute('uv1', new THREE.Float32BufferAttribute(uv1s, 2));
  }
  if (anyHasWear) {
    merged.setAttribute('aWearAO', new THREE.Float32BufferAttribute(wearAOs, 3));
  }
  merged.setIndex(indices);
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

export function mergeNamedMeshes(
  name: string,
  meshes: THREE.Mesh[],
  material: THREE.Material,
): THREE.Mesh {
  const geos: THREE.BufferGeometry[] = [];
  for (const m of meshes) {
    m.updateMatrix();
    const g = m.geometry.clone();
    g.applyMatrix4(m.matrix);
    geos.push(g);
  }
  const mergedGeo = mergeGeometries(geos);
  const out = new THREE.Mesh(mergedGeo, material);
  out.name = name;
  return out;
}

export function countDistinctZ(geometry: THREE.BufferGeometry): number {
  const pos = geometry.getAttribute('position');
  if (!pos) return 0;
  const set = new Set<number>();
  for (let i = 0; i < pos.count; i += 1) {
    set.add(Math.round(pos.getZ(i) * 1000));
  }
  return set.size;
}

export type WearAndCavityOptions = {
  convexGain?: number;
  concaveGain?: number;
  smoothPasses?: number;
};

/**
 * Computes geometric curvature edge-wear (R) and cavity AO (G) + bevel rim mask (B)
 * across welded topological positions, storing them in both `aWearAO` and `color`
 * (with `material.vertexColors = false`, so `aWearAO` drives our PBR shader cleanly).
 */
export function computeGeometryWearAndCavity(
  geometry: THREE.BufferGeometry,
  options: WearAndCavityOptions = {},
): THREE.BufferGeometry {
  const pos = geometry.getAttribute('position');
  if (!pos || pos.count === 0) return geometry;

  const convexGain = options.convexGain ?? 1.25;
  const concaveGain = options.concaveGain ?? 1.35;
  const smoothPasses = options.smoothPasses ?? 2;

  const idxAttr = geometry.getIndex();
  const triCount = idxAttr ? Math.floor(idxAttr.count / 3) : Math.floor(pos.count / 3);

  const vertToWelded = new Int32Array(pos.count);
  const weldedPos: [number, number, number][] = [];
  const keyMap = new Map<string, number>();

  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const k = `${Math.round(x * 1e5)}_${Math.round(y * 1e5)}_${Math.round(z * 1e5)}`;
    let wid = keyMap.get(k);
    if (wid === undefined) {
      wid = weldedPos.length;
      weldedPos.push([x, y, z]);
      keyMap.set(k, wid);
    }
    vertToWelded[i] = wid;
  }

  const W = weldedPos.length;
  const smoothNx = new Float32Array(W);
  const smoothNy = new Float32Array(W);
  const smoothNz = new Float32Array(W);

  type TriRec = {
    fnx: number;
    fny: number;
    fnz: number;
    cx: number;
    cy: number;
    cz: number;
  };
  const edgeTris = new Map<string, TriRec[]>();
  const neighbors: Set<number>[] = Array.from({ length: W }, () => new Set<number>());

  const pA = new THREE.Vector3();
  const pB = new THREE.Vector3();
  const pC = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const fn = new THREE.Vector3();

  for (let t = 0; t < triCount; t += 1) {
    const ia = idxAttr ? idxAttr.getX(t * 3) : t * 3;
    const ib = idxAttr ? idxAttr.getX(t * 3 + 1) : t * 3 + 1;
    const ic = idxAttr ? idxAttr.getX(t * 3 + 2) : t * 3 + 2;

    const wa = vertToWelded[ia];
    const wb = vertToWelded[ib];
    const wc = vertToWelded[ic];
    if (wa === wb || wb === wc || wc === wa) continue;

    pA.set(weldedPos[wa][0], weldedPos[wa][1], weldedPos[wa][2]);
    pB.set(weldedPos[wb][0], weldedPos[wb][1], weldedPos[wb][2]);
    pC.set(weldedPos[wc][0], weldedPos[wc][1], weldedPos[wc][2]);

    e1.subVectors(pB, pA);
    e2.subVectors(pC, pA);
    fn.crossVectors(e1, e2);
    const len = fn.length();
    if (len <= 1e-14) continue;
    fn.divideScalar(len);

    for (const w of [wa, wb, wc]) {
      smoothNx[w] += fn.x;
      smoothNy[w] += fn.y;
      smoothNz[w] += fn.z;
    }

    const triRec: TriRec = {
      fnx: fn.x,
      fny: fn.y,
      fnz: fn.z,
      cx: (pA.x + pB.x + pC.x) / 3,
      cy: (pA.y + pB.y + pC.y) / 3,
      cz: (pA.z + pB.z + pC.z) / 3,
    };

    const pairs: [number, number][] = [
      [wa, wb],
      [wb, wc],
      [wc, wa],
    ];
    for (const [u, v] of pairs) {
      neighbors[u].add(v);
      neighbors[v].add(u);
      const ek = u < v ? `${u}:${v}` : `${v}:${u}`;
      let arr = edgeTris.get(ek);
      if (!arr) {
        arr = [];
        edgeTris.set(ek, arr);
      }
      arr.push(triRec);
    }
  }

  for (let w = 0; w < W; w += 1) {
    const l = Math.hypot(smoothNx[w], smoothNy[w], smoothNz[w]) || 1;
    smoothNx[w] /= l;
    smoothNy[w] /= l;
    smoothNz[w] /= l;
  }

  const edgeConvex = new Float32Array(W);
  const edgeConcave = new Float32Array(W);

  for (const [ek, list] of edgeTris.entries()) {
    if (list.length < 2) continue;
    const sep = ek.indexOf(':');
    const wa = Number(ek.slice(0, sep));
    const wb = Number(ek.slice(sep + 1));

    const t0 = list[0];
    const t1 = list[1];
    const dotN = Math.max(-1, Math.min(1, t0.fnx * t1.fnx + t0.fny * t1.fny + t0.fnz * t1.fnz));
    const angle = Math.acos(dotN);
    if (angle < 0.14) continue;

    const bend = Math.min(1.0, (angle - 0.14) / 1.05);
    const dcx = t1.cx - t0.cx;
    const dcy = t1.cy - t0.cy;
    const dcz = t1.cz - t0.cz;
    const dcLen = Math.hypot(dcx, dcy, dcz) || 1;
    const dirSign = (t0.fnx * dcx + t0.fny * dcy + t0.fnz * dcz) / dcLen;

    if (dirSign < -0.015) {
      if (bend > edgeConvex[wa]) edgeConvex[wa] = bend;
      if (bend > edgeConvex[wb]) edgeConvex[wb] = bend;
    } else if (dirSign > 0.015) {
      if (bend > edgeConcave[wa]) edgeConcave[wa] = bend;
      if (bend > edgeConcave[wb]) edgeConcave[wb] = bend;
    }
  }

  // 1-ring tangent-plane projection catches gentle convex crests & concave grooves
  const ringConvex = new Float32Array(W);
  const ringConcave = new Float32Array(W);
  for (let w = 0; w < W; w += 1) {
    const nbs = neighbors[w];
    if (nbs.size === 0) continue;
    const [px, py, pz] = weldedPos[w];
    const nx = smoothNx[w];
    const ny = smoothNy[w];
    const nz = smoothNz[w];

    let sumPos = 0;
    let sumNeg = 0;
    let cnt = 0;
    for (const nb of nbs) {
      const dx = weldedPos[nb][0] - px;
      const dy = weldedPos[nb][1] - py;
      const dz = weldedPos[nb][2] - pz;
      const d = Math.hypot(dx, dy, dz);
      if (d < 1e-7) continue;
      const proj = -(nx * dx + ny * dy + nz * dz) / d;
      if (proj > 0.035) sumPos += Math.min(1, proj * 1.8);
      if (proj < -0.035) sumNeg += Math.min(1, -proj * 1.8);
      cnt += 1;
    }
    if (cnt > 0) {
      ringConvex[w] = Math.min(1, sumPos / Math.max(2, cnt * 0.5));
      ringConcave[w] = Math.min(1, sumNeg / Math.max(2, cnt * 0.5));
    }
  }

  let wearW = new Float32Array(W);
  let cavW = new Float32Array(W);
  const rimW = new Float32Array(W);
  for (let w = 0; w < W; w += 1) {
    const rawWear = Math.max(edgeConvex[w], ringConvex[w] * 0.85) * convexGain;
    const rawCav = Math.max(edgeConcave[w], ringConcave[w] * 0.90) * concaveGain;
    wearW[w] = Math.min(1, Math.max(0, rawWear));
    cavW[w] = Math.min(1, Math.max(0, rawCav));
    rimW[w] = Math.min(1, Math.max(edgeConvex[w], edgeConcave[w] * 0.4));
  }

  for (let pass = 0; pass < smoothPasses; pass += 1) {
    const nextWear = new Float32Array(W);
    const nextCav = new Float32Array(W);
    for (let w = 0; w < W; w += 1) {
      const nbs = neighbors[w];
      if (nbs.size === 0) {
        nextWear[w] = wearW[w];
        nextCav[w] = cavW[w];
        continue;
      }
      let sw = 0;
      let sc = 0;
      for (const nb of nbs) {
        sw += wearW[nb];
        sc += cavW[nb];
      }
      const avgW = sw / nbs.size;
      const avgC = sc / nbs.size;
      // Preserve crisp ridge peaks while bleeding wear softly onto bevel shoulders
      nextWear[w] = Math.max(wearW[w] * 0.88, wearW[w] * 0.62 + avgW * 0.38);
      nextCav[w] = Math.max(cavW[w] * 0.82, cavW[w] * 0.55 + avgC * 0.45);
    }
    wearW = nextWear;
    cavW = nextCav;
  }

  const wearAOArr = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i += 1) {
    const w = vertToWelded[i];
    const ew = Math.min(1, Math.max(0, wearW[w]));
    const ao = Math.min(1, Math.max(0.24, 1.0 - cavW[w] * 0.72));
    const rm = Math.min(1, Math.max(0, rimW[w]));
    wearAOArr[i * 3] = ew;
    wearAOArr[i * 3 + 1] = ao;
    wearAOArr[i * 3 + 2] = rm;
  }

  geometry.setAttribute('aWearAO', new THREE.BufferAttribute(wearAOArr, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(wearAOArr.slice(), 3));
  return geometry;
}

export type PhysicalUVOptions = {
  tileMeters?: number;
  mode?: 'triplanar' | 'cylindrical';
  cylAxis?: 'x' | 'y' | 'z';
  cylCenter?: Vec3;
};

/**
 * Assigns physically scaled UVs in meters (preserving seamless cylindrical UVs on Lathe profiles,
 * or splitting vertices cleanly along dominant-axis seams for triplanar box projection with zero
 * stretch and 0 bad edges). Also stores normalized planar [0..1] macro UVs in `uv1`.
 */
export function applyTriplanarPhysicalUVs(
  geometry: THREE.BufferGeometry,
  options: PhysicalUVOptions = {},
): THREE.BufferGeometry {
  const tileMeters = Math.max(0.005, options.tileMeters ?? 0.085);
  const mode = options.mode ?? 'triplanar';

  const pos = geometry.getAttribute('position');
  if (!pos || pos.count === 0) return geometry;

  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const bb = geometry.boundingBox!;
  const spanX = Math.max(1e-5, bb.max.x - bb.min.x);
  const spanY = Math.max(1e-5, bb.max.y - bb.min.y);

  // Ensure normalized macro uv1 exists
  if (!geometry.getAttribute('uv1')) {
    const uv1Arr = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i += 1) {
      uv1Arr[i * 2] = (pos.getX(i) - bb.min.x) / spanX;
      uv1Arr[i * 2 + 1] = (pos.getY(i) - bb.min.y) / spanY;
    }
    geometry.setAttribute('uv1', new THREE.BufferAttribute(uv1Arr, 2));
  }

  if (mode === 'cylindrical') {
    const uvAttr = geometry.getAttribute('uv');
    const cylAxis = options.cylAxis ?? 'x';
    const center = options.cylCenter ?? [
      (bb.min.x + bb.max.x) * 0.5,
      (bb.min.y + bb.max.y) * 0.5,
      (bb.min.z + bb.max.z) * 0.5,
    ];

    let rSum = 0;
    for (let i = 0; i < pos.count; i += 1) {
      const dx = pos.getX(i) - center[0];
      const dy = pos.getY(i) - center[1];
      const dz = pos.getZ(i) - center[2];
      const r =
        cylAxis === 'x'
          ? Math.hypot(dy, dz)
          : cylAxis === 'y'
            ? Math.hypot(dx, dz)
            : Math.hypot(dx, dy);
      rSum += r;
    }
    const rAvg = rSum / Math.max(1, pos.count);
    // Snap circumferential tiling to integer so theta=0 and theta=2pi repeat seamlessly
    const uRepeats = Math.max(1, Math.round((2 * Math.PI * rAvg) / tileMeters));

    const newUv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i += 1) {
      const uOrig = uvAttr ? uvAttr.getX(i) : 0;
      const axial =
        cylAxis === 'x' ? pos.getX(i) : cylAxis === 'y' ? pos.getY(i) : pos.getZ(i);
      newUv[i * 2] = uOrig * uRepeats;
      newUv[i * 2 + 1] = axial / tileMeters;
    }
    geometry.setAttribute('uv', new THREE.BufferAttribute(newUv, 2));
    return geometry;
  }

  // Triplanar per-triangle dominant axis projection, splitting only vertices shared across different axes
  const norm = geometry.getAttribute('normal');
  const uv1Attr = geometry.getAttribute('uv1');
  const wearAttr = geometry.getAttribute('aWearAO');
  const colAttr = geometry.getAttribute('color');
  const idxAttr = geometry.getIndex();
  const triCount = idxAttr ? Math.floor(idxAttr.count / 3) : Math.floor(pos.count / 3);

  const newPos: number[] = [];
  const newNorm: number[] = [];
  const newUv: number[] = [];
  const newUv1: number[] = [];
  const newWear: number[] = [];
  const newCol: number[] = [];
  const newIndices: number[] = [];

  const vertCache = new Map<number, number>();
  const pA = new THREE.Vector3();
  const pB = new THREE.Vector3();
  const pC = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const fn = new THREE.Vector3();

  const emitVertex = (origIdx: number, axis: 0 | 1 | 2): number => {
    const key = origIdx * 3 + axis;
    const cached = vertCache.get(key);
    if (cached !== undefined) return cached;

    const x = pos.getX(origIdx);
    const y = pos.getY(origIdx);
    const z = pos.getZ(origIdx);
    const newIdx = newPos.length / 3;
    newPos.push(x, y, z);

    if (norm) {
      newNorm.push(norm.getX(origIdx), norm.getY(origIdx), norm.getZ(origIdx));
    } else {
      newNorm.push(0, 1, 0);
    }

    if (axis === 2) {
      newUv.push(x / tileMeters, y / tileMeters);
    } else if (axis === 0) {
      newUv.push(z / tileMeters, y / tileMeters);
    } else {
      newUv.push(x / tileMeters, z / tileMeters);
    }

    if (uv1Attr) {
      newUv1.push(uv1Attr.getX(origIdx), uv1Attr.getY(origIdx));
    }
    if (wearAttr) {
      newWear.push(wearAttr.getX(origIdx), wearAttr.getY(origIdx), wearAttr.getZ(origIdx));
    }
    if (colAttr) {
      newCol.push(colAttr.getX(origIdx), colAttr.getY(origIdx), colAttr.getZ(origIdx));
    }

    vertCache.set(key, newIdx);
    return newIdx;
  };

  for (let t = 0; t < triCount; t += 1) {
    const ia = idxAttr ? idxAttr.getX(t * 3) : t * 3;
    const ib = idxAttr ? idxAttr.getX(t * 3 + 1) : t * 3 + 1;
    const ic = idxAttr ? idxAttr.getX(t * 3 + 2) : t * 3 + 2;

    pA.set(pos.getX(ia), pos.getY(ia), pos.getZ(ia));
    pB.set(pos.getX(ib), pos.getY(ib), pos.getZ(ib));
    pC.set(pos.getX(ic), pos.getY(ic), pos.getZ(ic));
    e1.subVectors(pB, pA);
    e2.subVectors(pC, pA);
    fn.crossVectors(e1, e2);

    const ax = Math.abs(fn.x);
    const ay = Math.abs(fn.y);
    const az = Math.abs(fn.z);
    let axis: 0 | 1 | 2 = 2;
    if (ax >= ay && ax >= az) axis = 0;
    else if (ay > ax && ay >= az) axis = 1;

    newIndices.push(emitVertex(ia, axis), emitVertex(ib, axis), emitVertex(ic, axis));
  }

  geometry.setAttribute('position', new THREE.Float32BufferAttribute(newPos, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(newNorm, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(newUv, 2));
  if (uv1Attr) {
    geometry.setAttribute('uv1', new THREE.Float32BufferAttribute(newUv1, 2));
  }
  if (wearAttr) {
    geometry.setAttribute('aWearAO', new THREE.Float32BufferAttribute(newWear, 3));
  }
  if (colAttr) {
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(newCol), 3));
  }
  geometry.setIndex(newIndices);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
