import { DRAGON_TIME_WRAP, FIRE_COLOR_GLSL, FIRE_NOISE_GLSL, fireTime } from "./fireShader";

type Point = { x: number; y: number };

/** The same turbulent fuel field and heat palette as DynamicComposer's fire skin, aimed along a breath jet. */
export function createDragonBreath(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext("webgl", { alpha: true, antialias: false, premultipliedAlpha: false });
  if (!gl) return null;
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("Unable to create dragon breath shader");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || "Dragon breath shader error");
    return shader;
  };
  const vertex = `attribute vec2 position; void main() { gl_Position = vec4(position, 0.0, 1.0); }`;
  const fragment = `
    precision highp float;
    uniform vec2 resolution;
    uniform float pixelRatio;
    uniform vec2 mouth;
    uniform vec2 target;
    uniform float time;
    uniform float growth;
    uniform float fade;
    ${FIRE_NOISE_GLSL}
    ${FIRE_COLOR_GLSL}
    void main() {
      vec2 p = vec2(gl_FragCoord.x, resolution.y - gl_FragCoord.y) / pixelRatio;
      vec2 path = target - mouth;
      float lengthPath = max(length(path), 1.0);
      vec2 forward = path / lengthPath;
      vec2 sideways = vec2(-forward.y, forward.x);
      float along = dot(p - mouth, forward) / lengthPath;
      float across = dot(p - mouth, sideways);
      float tip = growth;
      float travel = clamp(along / max(tip, 0.01), 0.0, 1.0);
      float warp = (fbm(vec2(along * 13.0 - time * 7.8, time * 2.1)) - 0.5) * (8.0 + 27.0 * travel);
      float shear = (noise(vec2(along * 26.0 - time * 13.0, across * 0.11)) - 0.5) * (4.0 + 14.0 * travel);
      float q = across - warp - shear;
      float fuel = fbm(vec2(along * 18.0 - time * 9.5, q * 0.085 + time * 2.6));
      // 尾部收尖：只在接近末端的小段内收窄成尖（粒子消散），主体保持喷到目标处，
      // 避免提前收窄让火焰看起来短一截、喷不到输入框。
      float taper = 1.0 - smoothstep(tip * 0.72, tip * 0.98, along);
      float width = mix(5.0, 34.0, pow(travel, 0.78)) * (0.52 + fuel * 1.05) * taper;
      float edge = 1.0 - smoothstep(width * 0.63, width * 1.2, abs(q));
      // 末端渐隐贴近 tip（tip*0.9 起淡），配合收尖形成"逐渐变小 → 消失"。
      float alongMask = smoothstep(-0.025, 0.04, along) * (1.0 - smoothstep(tip * 0.9, tip + 0.005, along));
      float body = edge * alongMask * (0.46 + 0.72 * smoothstep(0.22, 0.68, fuel));
      float flecks = smoothstep(0.72, 0.88, fbm(vec2(p.x * 0.26 - time * 11.0, p.y * 0.23 + time * 5.0)))
                    * (1.0 - smoothstep(width, width + 28.0, abs(q))) * alongMask * 0.38;
      float flame = body + flecks;
      float core = 1.0 - smoothstep(0.05, max(width, 1.0), abs(q));
      float heat = 0.2 + core * 0.95 + fuel * 0.28;
      vec3 color = fireColor(heat);
      float alpha = clamp(flame * (0.72 + fuel * 0.42) * fade, 0.0, 1.0);
      gl_FragColor = vec4(color, alpha);
    }
  `;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || "Dragon breath program error");
  gl.useProgram(program);
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "position");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const uniform = (name: string) => gl.getUniformLocation(program, name);
  const uResolution = uniform("resolution"), uRatio = uniform("pixelRatio");
  const uMouth = uniform("mouth"), uTarget = uniform("target");
  const uTime = uniform("time"), uGrowth = uniform("growth"), uFade = uniform("fade");
  return {
    /** 清空画布。喷火结束后必须显式清一次，之后不再排帧（否则残留最后一帧火焰）。 */
    clear() {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    },
    draw(now: number, start: Point, end: Point, elapsed: number, ratio: number) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (elapsed < 0 || elapsed >= 1150) return;
      gl.uniform2f(uResolution, canvas.width, canvas.height);
      gl.uniform1f(uRatio, ratio);
      gl.uniform2f(uMouth, start.x, start.y);
      gl.uniform2f(uTarget, end.x, end.y);
      // 时间必须有界：绝对秒数会让噪声坐标无限增长，hash 的 sin 参数过大后退化成常数，
      // 喷火会变成一坨没有细节的色块（见 fireShader.ts 顶部说明）。
      // 回绕点钉在「这次喷火开始之前」，喷火过程中相位只前进不回绕，不会喷到一半跳一下。
      const startMs = now - elapsed;
      gl.uniform1f(uTime, fireTime(startMs, DRAGON_TIME_WRAP) + elapsed * 0.001);
      gl.uniform1f(uGrowth, Math.min(1, elapsed / 270));
      gl.uniform1f(uFade, Math.min(1, (1150 - elapsed) / 300));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
    destroy() { gl.deleteBuffer(quad); gl.deleteProgram(program); },
  };
}
