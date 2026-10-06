// Ink dropped into a water tank, seen from the side.
// A small grid-based fluid simulation (Stable Fluids) carries an ink density field.
// Ink is heavier than water, so it sinks; as it falls it rolls up into mushroom
// caps and curling tendrils. Ink slowly fades as it settles and dilutes.

window.SKETCHES = window.SKETCHES || {};

window.SKETCHES.ink = function (p) {
  var RES = 200;              // cells along the longer side of the screen
  var PRESSURE_ITERS = 20;
  var SOR = 1.7;
  var VELOCITY_DAMP = 0.998;
  var INK_DECAY = 0.9992;
  var BUOYANCY = 0.05;        // downward pull per unit of ink
  var VORTICITY = 0.12;

  var W, H, S;                // inner grid size and row stride (W + 2)
  var u, v, u0, v0;
  var d, d0, d1, d2, pr, dv, curl;
  var buffer, bufferCtx, imageData;
  var absorb;
  var t = 0;
  var nextDrop = 0;
  var gridAspect = 0;

  var reduceMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  p.setup = function () {
    p.pixelDensity(1);
    p.createCanvas(p.windowWidth, p.windowHeight);
    absorb = pickInk();
    initGrid();

    addDrop(W * p.random(0.3, 0.7));
    nextDrop = p.random(300, 480);

    window.addEventListener('pointerdown', function (e) {
      addDrop(e.clientX / p.width * W + 0.5);
      if (reduceMotion) settle();
    });

    if (reduceMotion) settle();
  };

  p.draw = function () {
    if (t >= nextDrop) {
      addDrop(W * p.random(0.15, 0.85));
      nextDrop = t + p.random(360, 720);
    }
    step();
    render();
  };

  p.windowResized = function () {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
    var aspect = p.width / p.height;
    if (Math.abs(aspect - gridAspect) / gridAspect > 0.15) initGrid();
    if (reduceMotion) render();
  };

  // Without animation, run the simulation ahead and show a single still frame.
  function settle() {
    p.noLoop();
    for (var k = 0; k < 240; k++) step();
    render();
  }

  // Ink color as per-channel absorption, so thin ink is pale and thick ink deepens.
  function pickInk() {
    var rgb = hslToRgb(p.random(360), p.random(0.5, 0.85), p.random(0.25, 0.42));
    return rgb.map(function (c) { return -Math.log(Math.max(c, 0.02)); });
  }

  function hslToRgb(h, s, l) {
    var a = s * Math.min(l, 1 - l);
    function f(n) {
      var k = (n + h / 30) % 12;
      return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    }
    return [f(0), f(8), f(4)];
  }

  function initGrid() {
    gridAspect = p.width / p.height;
    if (gridAspect >= 1) {
      W = RES;
      H = Math.max(8, Math.round(RES / gridAspect));
    } else {
      H = RES;
      W = Math.max(8, Math.round(RES * gridAspect));
    }
    S = W + 2;
    var n = S * (H + 2);
    u = new Float32Array(n);
    v = new Float32Array(n);
    u0 = new Float32Array(n);
    v0 = new Float32Array(n);
    d = new Float32Array(n);
    d0 = new Float32Array(n);
    d1 = new Float32Array(n);
    d2 = new Float32Array(n);
    pr = new Float32Array(n);
    dv = new Float32Array(n);
    curl = new Float32Array(n);
    buffer = document.createElement('canvas');
    buffer.width = W;
    buffer.height = H;
    bufferCtx = buffer.getContext('2d');
    imageData = bufferCtx.createImageData(W, H);
  }

  // A drop hits the surface at x: a blob of ink just below the surface,
  // pushed downward, with a little noise so it does not fall symmetrically.
  function addDrop(x) {
    var scale = RES / 200;
    var r = p.random(2.8, 4) * scale;
    var y = r * 1.5 + 1;
    var ink = p.random(2, 3);
    var push = p.random(0.3, 0.6);
    var reach = Math.ceil(r * 3);
    for (var j = 1; j <= Math.min(H, Math.ceil(y + reach)); j++) {
      for (var i = Math.max(1, Math.floor(x - reach)); i <= Math.min(W, Math.ceil(x + reach)); i++) {
        var dx = i - x;
        var dy = j - y;
        var g = Math.exp(-(dx * dx + dy * dy) / (r * r));
        var id = i + S * j;
        d[id] += ink * g * p.random(0.7, 1.3);
        v[id] += push * g;
        u[id] += p.random(-0.08, 0.08) * g;
      }
    }
  }

  function step() {
    t++;
    addForces();

    u0.set(u);
    v0.set(v);
    advect(u, u0, u0, v0, 1);
    advect(v, v0, u0, v0, 1);
    velocityBoundary(u, v);
    project();

    advectInk();

    for (var id = 0; id < d.length; id++) {
      d[id] *= INK_DECAY;
      u[id] *= VELOCITY_DAMP;
      v[id] *= VELOCITY_DAMP;
    }
    densityBoundary();
  }

  // Ink is heavier than water (buoyancy), and vorticity confinement keeps the curls alive.
  function addForces() {
    var i, j, id;
    for (j = 1; j <= H; j++) {
      for (i = 1; i <= W; i++) {
        id = i + S * j;
        v[id] += BUOYANCY * d[id];
        curl[id] = 0.5 * ((v[id + 1] - v[id - 1]) - (u[id + S] - u[id - S]));
      }
    }
    for (j = 2; j < H; j++) {
      for (i = 2; i < W; i++) {
        id = i + S * j;
        var gx = 0.5 * (Math.abs(curl[id + 1]) - Math.abs(curl[id - 1]));
        var gy = 0.5 * (Math.abs(curl[id + S]) - Math.abs(curl[id - S]));
        var len = Math.sqrt(gx * gx + gy * gy) + 1e-5;
        u[id] += VORTICITY * (gy / len) * curl[id];
        v[id] -= VORTICITY * (gx / len) * curl[id];
      }
    }
  }

  // MacCormack advection keeps thin filaments of ink sharp: advect forward,
  // back again, and correct by half the round-trip error, clamped to the
  // values the forward step sampled from.
  function advectInk() {
    d0.set(d);
    advect(d1, d0, u, v, 1);
    advect(d2, d1, u, v, -1);
    var maxX = W + 0.5;
    var maxY = H + 0.5;
    for (var j = 1; j <= H; j++) {
      for (var i = 1; i <= W; i++) {
        var id = i + S * j;
        var x = Math.min(Math.max(i - u[id], 0.5), maxX);
        var y = Math.min(Math.max(j - v[id], 0.5), maxY);
        var a = Math.floor(x) + S * Math.floor(y);
        var c0 = d0[a], c1 = d0[a + 1], c2 = d0[a + S], c3 = d0[a + S + 1];
        var lo = Math.min(c0, c1, c2, c3);
        var hi = Math.max(c0, c1, c2, c3);
        var val = d1[id] + 0.5 * (d0[id] - d2[id]);
        d[id] = val < lo ? lo : val > hi ? hi : val;
      }
    }
  }

  // Semi-Lagrangian advection: trace each cell back along the flow
  // (or forward, with dir = -1).
  function advect(dst, s, uu, vv, dir) {
    var maxX = W + 0.5;
    var maxY = H + 0.5;
    for (var j = 1; j <= H; j++) {
      for (var i = 1; i <= W; i++) {
        var id = i + S * j;
        var x = Math.min(Math.max(i - dir * uu[id], 0.5), maxX);
        var y = Math.min(Math.max(j - dir * vv[id], 0.5), maxY);
        var ix = Math.floor(x);
        var iy = Math.floor(y);
        var sx = x - ix;
        var sy = y - iy;
        var a = ix + S * iy;
        dst[id] = (1 - sy) * ((1 - sx) * s[a] + sx * s[a + 1]) +
                  sy * ((1 - sx) * s[a + S] + sx * s[a + S + 1]);
      }
    }
  }

  // Make the flow divergence-free. Pressure is kept between frames as a warm start.
  function project() {
    var i, j, id;
    for (j = 1; j <= H; j++) {
      for (i = 1; i <= W; i++) {
        id = i + S * j;
        dv[id] = 0.5 * (u[id + 1] - u[id - 1] + v[id + S] - v[id - S]);
      }
    }
    for (var k = 0; k < PRESSURE_ITERS; k++) {
      for (j = 1; j <= H; j++) {
        for (i = 1; i <= W; i++) {
          id = i + S * j;
          var next = (pr[id - 1] + pr[id + 1] + pr[id - S] + pr[id + S] - dv[id]) * 0.25;
          pr[id] += SOR * (next - pr[id]);
        }
      }
      copyEdges(pr);
    }
    for (j = 1; j <= H; j++) {
      for (i = 1; i <= W; i++) {
        id = i + S * j;
        u[id] -= 0.5 * (pr[id + 1] - pr[id - 1]);
        v[id] -= 0.5 * (pr[id + S] - pr[id - S]);
      }
    }
    velocityBoundary(u, v);
  }

  // The tank: water cannot pass through the walls, the bottom, or the surface,
  // but may slide along them.
  function velocityBoundary(uu, vv) {
    var i, j;
    for (i = 1; i <= W; i++) {
      uu[i] = uu[i + S];
      vv[i] = -vv[i + S];
      uu[i + S * (H + 1)] = uu[i + S * H];
      vv[i + S * (H + 1)] = -vv[i + S * H];
    }
    for (j = 1; j <= H; j++) {
      uu[S * j] = -uu[1 + S * j];
      vv[S * j] = vv[1 + S * j];
      uu[W + 1 + S * j] = -uu[W + S * j];
      vv[W + 1 + S * j] = vv[W + S * j];
    }
  }

  // Ink stays in the tank.
  function densityBoundary() {
    copyEdges(d);
  }

  function copyEdges(f) {
    var i, j;
    for (i = 1; i <= W; i++) {
      f[i] = f[i + S];
      f[i + S * (H + 1)] = f[i + S * H];
    }
    for (j = 0; j < H + 2; j++) {
      f[S * j] = f[1 + S * j];
      f[W + 1 + S * j] = f[W + S * j];
    }
  }

  // White water; ink absorbs light per channel (Beer–Lambert).
  function render() {
    // Write pixels into our own small buffer (no readback), then scale it up.
    var px = imageData.data;
    var o = 0;
    for (var j = 1; j <= H; j++) {
      for (var i = 1; i <= W; i++) {
        var dd = d[i + S * j];
        px[o] = 255 * Math.exp(-dd * absorb[0]);
        px[o + 1] = 255 * Math.exp(-dd * absorb[1]);
        px[o + 2] = 255 * Math.exp(-dd * absorb[2]);
        px[o + 3] = 255;
        o += 4;
      }
    }
    bufferCtx.putImageData(imageData, 0, 0);
    var ctx = p.drawingContext;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(buffer, 0, 0, p.width, p.height);
  }
};
