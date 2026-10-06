// Ink dropped into a water tank, seen from the side.
// A grid-based fluid simulation (Stable Fluids) runs on the GPU with WebGL2 shaders.
// The water flow uses a coarse grid and the ink a fine one, so the ink stays crisp.
// Ink is heavier than water, so it sinks; as it falls it rolls up into mushroom
// caps and curling tendrils. Ink slowly fades as it settles and dilutes.
// p5 only drives the frame loop; drawing goes to our own WebGL2 canvas.

window.SKETCHES = window.SKETCHES || {};

window.SKETCHES.ink = function (p, host) {
  var SIM_RES = 256;          // water flow: cells along the longer side
  var DYE_RES = 1024;         // ink: cells along the longer side
  var PRESSURE_ITERS = 30;
  var PRESSURE_KEEP = 0.9;    // warm start from the previous frame's pressure
  var VELOCITY_DAMP = 0.998;
  var INK_DECAY_TOP = 0.9995;  // ink fades slowly near the surface…
  var INK_DECAY_BOTTOM = 0.992; // …and faster as it settles near the bottom
  var BUOYANCY = 0.03;        // downward pull per unit of ink (flow cells per frame)
  var VORTICITY = 0.1;
  var INK_FLOOR = 0.03;        // ink thinner than this is not drawn, so no haze lingers

  // Ink colors, roughly PCCS vivid tones (plus black). One is picked per page load.
  var INKS = [
    '#D7003A', // red
    '#EE7800', // orange
    '#FFD900', // yellow
    '#8FC31F', // yellow green
    '#00A05A', // green
    '#0068B7', // blue
    '#4D3C9E', // violet
    '#7B2E8F', // purple
    '#C0267B', // red purple
    '#1F1F1F'  // black
  ];

  var canvas, gl, quad, formats, prog;
  var velocity, pressure, divergence, curl, dye, dyeFwd, dyeBack;
  var simW, simH, dyeW, dyeH;
  var absorb;
  var t = 0;
  var nextDrop = 0;
  var gridAspect = 0;

  var reduceMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  p.setup = function () {
    p.noCanvas();
    canvas = document.createElement('canvas');
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    host.appendChild(canvas);

    gl = canvas.getContext('webgl2', {
      alpha: false, depth: false, stencil: false, antialias: false
    });
    if (!gl || !(formats = findFormats())) {
      // Without WebGL2 half-float targets the background simply stays white.
      p.noLoop();
      return;
    }

    absorb = pickInk();
    initGL();
    resizeCanvas();
    initFields();

    addDrop(p.random(0.3, 0.7));
    nextDrop = p.random(300, 480);

    window.addEventListener('pointerdown', function (e) {
      addDrop(e.clientX / window.innerWidth);
      if (reduceMotion) settle();
    });

    if (reduceMotion) settle();
  };

  p.draw = function () {
    if (t >= nextDrop) {
      addDrop(p.random(0.15, 0.85));
      nextDrop = t + p.random(360, 720);
    }
    step();
    render();
  };

  p.windowResized = function () {
    if (!formats) return;
    resizeCanvas();
    var aspect = canvas.width / canvas.height;
    if (Math.abs(aspect - gridAspect) / gridAspect > 0.15) initFields();
    render();
  };

  // Without animation, run the simulation ahead and show a single still frame.
  function settle() {
    p.noLoop();
    for (var k = 0; k < 240; k++) step();
    render();
  }

  // Ink color as per-channel absorption, so thin ink is pale and thick ink deepens.
  function pickInk() {
    var hex = p.random(INKS);
    var rgb = [1, 3, 5].map(function (k) { return parseInt(hex.slice(k, k + 2), 16) / 255; });
    return rgb.map(function (c) { return -Math.log(Math.max(c, 0.02)); });
  }

  function resizeCanvas() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
  }

  function gridSize(res, aspect) {
    return aspect >= 1
      ? [res, Math.max(8, Math.round(res / aspect))]
      : [Math.max(8, Math.round(res * aspect)), res];
  }

  function initFields() {
    gridAspect = canvas.width / canvas.height;
    var s = gridSize(SIM_RES, gridAspect);
    var d = gridSize(DYE_RES, gridAspect);
    simW = s[0]; simH = s[1];
    dyeW = d[0]; dyeH = d[1];
    velocity = doubleTarget(simW, simH, formats.rg);
    pressure = doubleTarget(simW, simH, formats.r);
    divergence = target(simW, simH, formats.r);
    curl = target(simW, simH, formats.r);
    dye = doubleTarget(dyeW, dyeH, formats.r);
    dyeFwd = target(dyeW, dyeH, formats.r);
    dyeBack = target(dyeW, dyeH, formats.r);
  }

  // A drop hits the surface at x (0–1 across the screen): a blob of ink just below
  // the surface, pushed downward, with a little noise so it does not fall symmetrically.
  function addDrop(x) {
    var r = p.random(2.8, 4) / 200;              // radius as a fraction of the longer side
    var long = Math.max(canvas.width, canvas.height);
    var y = 1 - (r * 1.5 + 0.005) * long / canvas.height;
    var common = {
      uPoint: [x, y],
      uRadius: r * long,
      uScreen: [canvas.width, canvas.height],
      uSeed: p.random(1000)
    };
    run(prog.splatDye, dye.write, assign(common, {
      uTarget: dye.read,
      uAmount: p.random(2, 3)
    }));
    dye.swap();
    run(prog.splatVelocity, velocity.write, assign(common, {
      uTarget: velocity.read,
      uPush: p.random(0.3, 0.6),
      uJitter: 0.08
    }));
    velocity.swap();
  }

  function step() {
    t++;
    var simTexel = [1 / simW, 1 / simH];

    run(prog.curl, curl, { uTexel: simTexel, uVelocity: velocity.read });
    run(prog.forces, velocity.write, {
      uTexel: simTexel,
      uVelocity: velocity.read,
      uCurl: curl,
      uDye: dye.read,
      uVorticity: VORTICITY,
      uBuoyancy: BUOYANCY
    });
    velocity.swap();

    run(prog.divergence, divergence, { uTexel: simTexel, uVelocity: velocity.read });
    run(prog.scale, pressure.write, { uTarget: pressure.read, uValue: PRESSURE_KEEP });
    pressure.swap();
    for (var k = 0; k < PRESSURE_ITERS; k++) {
      run(prog.pressure, pressure.write, {
        uTexel: simTexel,
        uPressure: pressure.read,
        uDivergence: divergence
      });
      pressure.swap();
    }
    run(prog.gradient, velocity.write, {
      uTexel: simTexel,
      uPressure: pressure.read,
      uVelocity: velocity.read
    });
    velocity.swap();

    run(prog.advect, velocity.write, {
      uVelocity: velocity.read,
      uSource: velocity.read,
      uSimTexel: simTexel,
      uDirection: 1,
      uDissipation: VELOCITY_DAMP
    });
    velocity.swap();

    // MacCormack advection keeps thin filaments of ink sharp: advect forward,
    // back again, and correct by half the round-trip error, clamped to the
    // values the forward step sampled from.
    var ink = { uVelocity: velocity.read, uSimTexel: simTexel, uDissipation: 1 };
    run(prog.advect, dyeFwd, assign(ink, { uSource: dye.read, uDirection: 1 }));
    run(prog.advect, dyeBack, assign(ink, { uSource: dyeFwd, uDirection: -1 }));
    run(prog.maccormack, dye.write, {
      uVelocity: velocity.read,
      uSimTexel: simTexel,
      uSource: dye.read,
      uForward: dyeFwd,
      uBack: dyeBack,
      uSize: [dyeW, dyeH],
      uDecayTop: INK_DECAY_TOP,
      uDecayBottom: INK_DECAY_BOTTOM
    });
    dye.swap();
  }

  // White water; ink absorbs light per channel (Beer–Lambert).
  function render() {
    run(prog.display, null, { uDye: dye.read, uAbsorb: absorb, uFloor: INK_FLOOR });
  }

  // ---- WebGL plumbing ----

  var VERTEX = [
    '#version 300 es',
    'in vec2 aPosition;',
    'uniform vec2 uTexel;',
    'out vec2 vUv, vL, vR, vT, vB;',
    'void main() {',
    '  vUv = aPosition * 0.5 + 0.5;',
    '  vL = vUv - vec2(uTexel.x, 0.0);',
    '  vR = vUv + vec2(uTexel.x, 0.0);',
    '  vT = vUv + vec2(0.0, uTexel.y);',
    '  vB = vUv - vec2(0.0, uTexel.y);',
    '  gl_Position = vec4(aPosition, 0.0, 1.0);',
    '}'
  ].join('\n');

  var HEADER = [
    '#version 300 es',
    'precision highp float;',
    'precision highp sampler2D;',
    'in vec2 vUv, vL, vR, vT, vB;',
    'out vec4 outColor;',
    'float hash(vec2 q) { return fract(sin(dot(q, vec2(12.9898, 78.233))) * 43758.5453); }',
    ''
  ].join('\n');

  // In these shaders y points up: the surface is at the top (uv.y = 1).
  var FRAGMENTS = {
    curl: [
      'uniform sampler2D uVelocity;',
      'void main() {',
      '  float L = texture(uVelocity, vL).y, R = texture(uVelocity, vR).y;',
      '  float T = texture(uVelocity, vT).x, B = texture(uVelocity, vB).x;',
      '  outColor = vec4(0.5 * ((R - L) - (T - B)), 0.0, 0.0, 1.0);',
      '}'
    ],
    // Vorticity confinement keeps the curls alive; ink is heavier than water.
    forces: [
      'uniform sampler2D uVelocity, uCurl, uDye;',
      'uniform float uVorticity, uBuoyancy;',
      'void main() {',
      '  float L = abs(texture(uCurl, vL).x), R = abs(texture(uCurl, vR).x);',
      '  float T = abs(texture(uCurl, vT).x), B = abs(texture(uCurl, vB).x);',
      '  float C = texture(uCurl, vUv).x;',
      '  vec2 g = 0.5 * vec2(R - L, T - B);',
      '  g /= length(g) + 1e-5;',
      '  vec2 v = texture(uVelocity, vUv).xy;',
      '  v += uVorticity * vec2(g.y, -g.x) * C;',
      '  v.y -= uBuoyancy * texture(uDye, vUv).x;',
      '  outColor = vec4(v, 0.0, 1.0);',
      '}'
    ],
    // The tank walls, bottom and surface reflect the flow.
    divergence: [
      'uniform sampler2D uVelocity;',
      'void main() {',
      '  vec2 C = texture(uVelocity, vUv).xy;',
      '  float L = texture(uVelocity, vL).x, R = texture(uVelocity, vR).x;',
      '  float T = texture(uVelocity, vT).y, B = texture(uVelocity, vB).y;',
      '  if (vL.x < 0.0) L = -C.x;',
      '  if (vR.x > 1.0) R = -C.x;',
      '  if (vT.y > 1.0) T = -C.y;',
      '  if (vB.y < 0.0) B = -C.y;',
      '  outColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);',
      '}'
    ],
    scale: [
      'uniform sampler2D uTarget;',
      'uniform float uValue;',
      'void main() { outColor = uValue * texture(uTarget, vUv); }'
    ],
    pressure: [
      'uniform sampler2D uPressure, uDivergence;',
      'void main() {',
      '  float L = texture(uPressure, vL).x, R = texture(uPressure, vR).x;',
      '  float T = texture(uPressure, vT).x, B = texture(uPressure, vB).x;',
      '  float d = texture(uDivergence, vUv).x;',
      '  outColor = vec4(0.25 * (L + R + T + B - d), 0.0, 0.0, 1.0);',
      '}'
    ],
    gradient: [
      'uniform sampler2D uPressure, uVelocity;',
      'void main() {',
      '  float L = texture(uPressure, vL).x, R = texture(uPressure, vR).x;',
      '  float T = texture(uPressure, vT).x, B = texture(uPressure, vB).x;',
      '  vec2 v = texture(uVelocity, vUv).xy - 0.5 * vec2(R - L, T - B);',
      '  outColor = vec4(v, 0.0, 1.0);',
      '}'
    ],
    // Semi-Lagrangian advection: trace back along the flow (or forward, with direction -1).
    advect: [
      'uniform sampler2D uVelocity, uSource;',
      'uniform vec2 uSimTexel;',
      'uniform float uDirection, uDissipation;',
      'void main() {',
      '  vec2 from = vUv - uDirection * texture(uVelocity, vUv).xy * uSimTexel;',
      '  outColor = uDissipation * texture(uSource, from);',
      '}'
    ],
    maccormack: [
      'uniform sampler2D uVelocity, uSource, uForward, uBack;',
      'uniform vec2 uSimTexel, uSize;',
      'uniform float uDecayTop, uDecayBottom;',
      'void main() {',
      '  vec2 from = vUv - texture(uVelocity, vUv).xy * uSimTexel;',
      '  ivec2 i = ivec2(floor(from * uSize - 0.5));',
      '  ivec2 hi = ivec2(uSize) - 1;',
      '  float a = texelFetch(uSource, clamp(i, ivec2(0), hi), 0).x;',
      '  float b = texelFetch(uSource, clamp(i + ivec2(1, 0), ivec2(0), hi), 0).x;',
      '  float c = texelFetch(uSource, clamp(i + ivec2(0, 1), ivec2(0), hi), 0).x;',
      '  float d = texelFetch(uSource, clamp(i + ivec2(1, 1), ivec2(0), hi), 0).x;',
      '  float f = texture(uForward, vUv).x;',
      '  float v = f + 0.5 * (texture(uSource, vUv).x - texture(uBack, vUv).x);',
      '  v = clamp(v, min(min(a, b), min(c, d)), max(max(a, b), max(c, d)));',
      '  float decay = mix(uDecayBottom, uDecayTop, smoothstep(0.0, 0.7, vUv.y));',
      '  outColor = vec4(decay * v, 0.0, 0.0, 1.0);',
      '}'
    ],
    splatDye: [
      'uniform sampler2D uTarget;',
      'uniform vec2 uPoint, uScreen;',
      'uniform float uRadius, uAmount, uSeed;',
      'void main() {',
      '  vec2 d = (vUv - uPoint) * uScreen;',
      '  float g = exp(-dot(d, d) / (uRadius * uRadius));',
      '  float grain = 0.7 + 0.6 * hash(vUv * 917.0 + uSeed);',
      '  outColor = texture(uTarget, vUv) + vec4(uAmount * g * grain, 0.0, 0.0, 0.0);',
      '}'
    ],
    splatVelocity: [
      'uniform sampler2D uTarget;',
      'uniform vec2 uPoint, uScreen;',
      'uniform float uRadius, uPush, uJitter, uSeed;',
      'void main() {',
      '  vec2 d = (vUv - uPoint) * uScreen;',
      '  float g = exp(-dot(d, d) / (uRadius * uRadius));',
      '  float jitter = uJitter * (2.0 * hash(vUv * 613.0 + uSeed) - 1.0);',
      '  outColor = texture(uTarget, vUv) + vec4(jitter * g, -uPush * g, 0.0, 0.0);',
      '}'
    ],
    display: [
      'uniform sampler2D uDye;',
      'uniform vec3 uAbsorb;',
      'uniform float uFloor;',
      'void main() {',
      '  float ink = max(texture(uDye, vUv).x - uFloor, 0.0);',
      '  outColor = vec4(exp(-ink * uAbsorb), 1.0);',
      '}'
    ]
  };

  function initGL() {
    quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    var vs = compile(gl.VERTEX_SHADER, VERTEX);
    prog = {};
    Object.keys(FRAGMENTS).forEach(function (name) {
      prog[name] = link(vs, compile(gl.FRAGMENT_SHADER, HEADER + FRAGMENTS[name].join('\n')));
    });
  }

  function compile(type, source) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader));
    }
    return shader;
  }

  function link(vs, fs) {
    var program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, 'aPosition');
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program));
    }
    var uniforms = {};
    var count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (var k = 0; k < count; k++) {
      var info = gl.getActiveUniform(program, k);
      uniforms[info.name] = { location: gl.getUniformLocation(program, info.name), type: info.type };
    }
    return { program: program, uniforms: uniforms };
  }

  // Draw a full-screen quad with a program into a target (null = the screen).
  function run(pr, dest, values) {
    gl.useProgram(pr.program);
    var unit = 0;
    Object.keys(pr.uniforms).forEach(function (name) {
      var u = pr.uniforms[name];
      var value = values[name];
      if (value === undefined) return;
      if (u.type === gl.SAMPLER_2D) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, value.texture);
        gl.uniform1i(u.location, unit++);
      } else if (u.type === gl.FLOAT) {
        gl.uniform1f(u.location, value);
      } else if (u.type === gl.FLOAT_VEC2) {
        gl.uniform2fv(u.location, value);
      } else if (u.type === gl.FLOAT_VEC3) {
        gl.uniform3fv(u.location, value);
      }
    });
    if (dest) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, dest.framebuffer);
      gl.viewport(0, 0, dest.width, dest.height);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function target(w, h, format) {
    var texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, format.internal, w, h, 0, format.format, gl.HALF_FLOAT, null);
    var framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { texture: texture, framebuffer: framebuffer, width: w, height: h };
  }

  function doubleTarget(w, h, format) {
    var pair = {
      read: target(w, h, format),
      write: target(w, h, format),
      swap: function () {
        var tmp = pair.read;
        pair.read = pair.write;
        pair.write = tmp;
      }
    };
    return pair;
  }

  // Half-float render targets need an extension; fall back to wider formats
  // where one- or two-channel targets are not renderable.
  function findFormats() {
    if (!gl.getExtension('EXT_color_buffer_float') &&
        !gl.getExtension('EXT_color_buffer_half_float')) return null;
    var r = [gl.R16F, gl.RED], rg = [gl.RG16F, gl.RG], rgba = [gl.RGBA16F, gl.RGBA];
    var pick = function (list) {
      for (var k = 0; k < list.length; k++) {
        if (renderable(list[k][0], list[k][1])) return { internal: list[k][0], format: list[k][1] };
      }
      return null;
    };
    var result = { r: pick([r, rg, rgba]), rg: pick([rg, rgba]) };
    return result.r && result.rg ? result : null;
  }

  function renderable(internal, format) {
    var texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, 4, 4, 0, format, gl.HALF_FLOAT, null);
    var framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    var ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    return ok;
  }

  function assign(base, extra) {
    var out = {};
    Object.keys(base).forEach(function (k) { out[k] = base[k]; });
    Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
    return out;
  }
};
