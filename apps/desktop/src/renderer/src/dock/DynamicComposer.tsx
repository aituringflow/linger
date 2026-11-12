import { useEffect, useRef } from "react";
import type { FireParams, GoldParams, WaterParams } from "../../../shared/types";
import { isDragActive } from "./dragIdle";
import { BURNING_FRAGMENT_GLSL, fireTime } from "./fireShader";
import { GOLD_FRAGMENT_GLSL } from "./goldShader";
import { WATER_FRAGMENT_GLSL } from "./waterShader";
import { caretPoint } from "./caretPoint";

/** Gold 流光调参区。距离用 CSS 像素，时间用秒；外观菜单的流光速度会再乘到实际位移上。 */
const GOLD_PHYSICS = {
  maxSpeed: 320,             // 速度上限（px/s）
  idleInitialSpeed: 84,      // 静止态定时推力后的速度（px/s）
  inputImpulse: 64,         // 每次新增输入增加的速度（px/s）；删除不加力
  inputMinSpeed: 84,        // 输入后的最低速度（px/s）
  friction: 4,              // 固定减速度（px/s²），越小越容易累积速度，须大于 0
  velocityDrag: .0016,     // 输入后：减速度 = friction + velocityDrag × 速度²；500→60 px/s 约 7.43 秒
  idleDeceleration: 0,     // 静止态自动流光的减速度（px/s²），0 为匀速，到时间淡出
  fadeOutSpeed: 60,         // 低于此速度完全隐藏，剩余速度仍参与下一次加力
  fullVisibilitySpeed: 72,  // 高于此速度完全可见；与淡出阈值之间平滑淡出
  fadeInSeconds: .3,        // 出现时的淡入时间
  peakOpacity: .9,          // 流光最高强度（0～1）
  idleMaxSeconds: 3,        // 静止态每波最长显示时间
  maxNoInputSeconds: 6,     // 最后一次新增输入后，最多显示多久
  timeoutFadeSeconds: .6,  // 时间上限到达前的淡出时长
  firstWaveDelayMs: 700,    // 初次出现的等待时间（毫秒）
  idleGapMinMs: 1000,       // 淡出后下一波的最短间隔（毫秒）
  idleGapRandomMs: 1500,    // 在最短间隔上随机增加的时间（毫秒）
} as const;
// velocityDrag 为 0 时，静止态可见时长 = (idleInitialSpeed - fadeOutSpeed) / friction。

type DynamicSkin = "fire" | "gold" | "water";
type Props = { skin: DynamicSkin | null; fireParams?: FireParams; goldParams?: GoldParams; waterParams?: WaterParams; windowId: string };
type DrawContext = {
  gl: WebGLRenderingContext;
  uniform: (name: string) => WebGLUniformLocation | null;
  now: number;
  cardWidth: number;
  cardHeight: number;
  pad: number;
  ratio: number;
  composer: HTMLElement;
  radius: number;
  fireParams?: FireParams;
  goldParams?: GoldParams;
  waterParams?: WaterParams;
  waterTime: number;
  waterActivity: number;
  waterCaret: [number, number];
  waterCaretVisible: number;
  flowTime: number;
  flowActivity: number;
  idleAngle: number;
  idleActivity: number;
  trailLength: number;
  trailStrength: number;
  particles: Float32Array;
};

const FIRE_PRESET = { intensity: 2, top: 15, side: 12, bottom: 4 } as const;
const FRAME_MS = 1000 / 30;
const WATER_PRESS_INTERVAL_MS = 350;

const skins = {
  fire: {
    className: "burning-composer-canvas",
    fragment: BURNING_FRAGMENT_GLSL,
    skinClass: "skin-wp4",
    pad: (height: number) => Math.ceil(24 * Math.max(1, Math.min(height / 56, 2.5))),
    draw({ gl, uniform, now, cardWidth, cardHeight, pad, ratio, radius, fireParams }: DrawContext) {
      const visualScale = Math.max(1, Math.min(cardHeight / 56, 2.5));
      const intensity = fireParams?.intensity ?? FIRE_PRESET.intensity;
      const scale = .25 + .75 * ((fireParams?.amplitude ?? 50) / 100);
      gl.uniform2f(uniform("resolution"), cardWidth + pad * 2, cardHeight + pad * 2);
      gl.uniform1f(uniform("pixelRatio"), ratio);
      gl.uniform1f(uniform("visualScale"), visualScale);
      gl.uniform4f(uniform("box"), pad / visualScale, pad / visualScale, cardWidth / visualScale, cardHeight / visualScale);
      gl.uniform1f(uniform("radius"), Math.min(radius, cardHeight / 2) / visualScale);
      gl.uniform1f(uniform("time"), fireTime(now));
      gl.uniform1f(uniform("intensity"), intensity);
      gl.uniform1f(uniform("topReach"), FIRE_PRESET.top * scale);
      gl.uniform1f(uniform("sideReach"), FIRE_PRESET.side * scale);
      gl.uniform1f(uniform("bottomReach"), FIRE_PRESET.bottom * scale);
      gl.uniform1f(uniform("turbulence"), intensity * .39);
    },
  },
  gold: {
    className: "gold-composer-canvas",
    fragment: GOLD_FRAGMENT_GLSL,
    skinClass: "skin-wp6",
    pad: () => 32,
    draw({ gl, uniform, cardWidth, cardHeight, pad, ratio, goldParams, flowTime, flowActivity, idleAngle, idleActivity, trailLength, trailStrength, particles }: DrawContext) {
      gl.uniform2f(uniform("resolution"), cardWidth + pad * 2, cardHeight + pad * 2);
      gl.uniform4f(uniform("box"), pad, pad, cardWidth, cardHeight);
      gl.uniform1f(uniform("pixelRatio"), ratio);
      gl.uniform1f(uniform("time"), flowTime);
      gl.uniform1f(uniform("sparkle"), goldParams?.sparkle ?? 1);
      gl.uniform1f(uniform("activity"), flowActivity);
      gl.uniform1f(uniform("idleAngle"), idleAngle);
      gl.uniform1f(uniform("idleActivity"), idleActivity);
      gl.uniform1f(uniform("trailLength"), trailLength);
      gl.uniform1f(uniform("trailStrength"), trailStrength);
      gl.uniform4fv(uniform("particles[0]"), particles);
    },
  },
  water: {
    className: "water-composer-canvas",
    fragment: WATER_FRAGMENT_GLSL,
    skinClass: "skin-wp5",
    pad: () => 55,
    draw({ gl, uniform, cardWidth, cardHeight, pad, ratio, waterParams, waterTime, waterActivity, waterCaret, waterCaretVisible }: DrawContext) {
      const tint = /^#[\da-f]{6}$/i.test(waterParams?.tint ?? "") ? waterParams!.tint : "#4a9fca";
      gl.uniform2f(uniform("resolution"), cardWidth + pad * 2, cardHeight + pad * 2);
      gl.uniform4f(uniform("box"), pad, pad, cardWidth, cardHeight);
      gl.uniform1f(uniform("pixelRatio"), ratio);
      gl.uniform1f(uniform("time"), waterTime);
      gl.uniform1f(uniform("amplitude"), Math.max(0, Math.min(1, waterParams?.amplitude ?? .2)));
      gl.uniform1f(uniform("activity"), waterActivity);
      gl.uniform2f(uniform("caret"), waterCaret[0], waterCaret[1]);
      gl.uniform1f(uniform("caretVisible"), waterCaretVisible);
      gl.uniform3f(uniform("tint"), parseInt(tint.slice(1, 3), 16) / 255, parseInt(tint.slice(3, 5), 16) / 255, parseInt(tint.slice(5, 7), 16) / 255);
      gl.uniform1i(uniform("waterTexture"), 0);
    },
  },
} satisfies Record<DynamicSkin, {
  className: string;
  fragment: string;
  skinClass: string;
  pad: (height: number) => number;
  draw: (context: DrawContext) => void;
}>;

/** One lifecycle for every dynamic composer: mount, resize, frame pacing and cleanup. */
export default function DynamicComposer({ skin, fireParams, goldParams, waterParams, windowId }: Props) {
  const paramsRef = useRef({ fireParams, goldParams, waterParams });
  paramsRef.current = { fireParams, goldParams, waterParams };
  useEffect(() => {
    if (!skin) return;
    const config = skins[skin];
    const canvas = document.createElement("canvas");
    canvas.className = `dynamic-composer-canvas ${config.className}`;
    canvas.setAttribute("aria-hidden", "true");
    const gl = canvas.getContext("webgl", { alpha: true, antialias: false, premultipliedAlpha: false });
    if (!gl) return;
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || "Dynamic shader error");
      return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, "attribute vec2 position;void main(){gl_Position=vec4(position,0.,1.);}");
    const fragment = compile(gl.FRAGMENT_SHADER, config.fragment);
    const program = gl.createProgram()!;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || "Dynamic program error");
    gl.useProgram(program);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const locations = new Map<string, WebGLUniformLocation | null>();
    const uniform = (name: string) => {
      if (!locations.has(name)) locations.set(name, gl.getUniformLocation(program, name));
      return locations.get(name)!;
    };
    let texture: WebGLTexture | null = null;
    let waterImage: HTMLImageElement | null = null;
    if (skin === "water") {
      texture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([39, 111, 128, 255]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      waterImage = new Image();
      waterImage.onload = () => { if (!waterImage || !texture) return; gl.bindTexture(gl.TEXTURE_2D, texture); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, waterImage); };
      waterImage.src = "wallpapers/water-surface.jpg";
    }
    const dragon = skin === "gold" ? document.createElement("img") : null;
    if (dragon) {
      dragon.className = "gold-composer-dragon";
      dragon.src = "wallpapers/gold-dragon.png";
      dragon.alt = "";
      dragon.setAttribute("aria-hidden", "true");
    }
    let frameId = 0, lastDrawn = 0, lastMotionAt = 0, lastWidth = 0, lastHeight = 0, radius = 20;
    const physics = GOLD_PHYSICS;
    let momentum = 0, flowTime = 0;
    let waterTime = 0, waterActivity = 0, waterVelocity = 0, lastWaterAt = 0;
    let waterCaret: [number, number] = [0, 0], caretDirty = true;
    let pressCaret: [number, number] = [0, 0], pendingWaterPress = false, lastWaterPress = -Infinity;
    const markCaretDirty = () => { caretDirty = true; };
    let inputDriven = false;
    let trailLength = 0;
    let nextParticleAt = 0;
    let particles: { along: number; born: number; vx: number; vy: number }[] = [];
    let idleStart = performance.now() + physics.firstWaveDelayMs;
    let lastForceAt = performance.now(), timeoutHidden = false;
    let idleAngle = Math.random() * 10000, idleActivity = 0, waveAge = 0;
    let composer: HTMLElement | null = null, input: HTMLElement | null = null;
    const onInput = (event: Event) => {
      if (skin === "water") {
        caretDirty = true;
        const now = performance.now();
        if (!(event as InputEvent).inputType?.startsWith("delete") && now - lastWaterPress >= WATER_PRESS_INTERVAL_MS) {
          lastWaterPress = now;
          pendingWaterPress = true;
          waterVelocity = Math.min(2.5, waterVelocity + 1.5);
        }
        return;
      }
      if ((event as InputEvent).inputType?.startsWith("delete")) return;
      inputDriven = true;
      if (momentum <= physics.fadeOutSpeed || timeoutHidden) waveAge = 0;
      lastForceAt = performance.now();
      timeoutHidden = false;
      // Preserve the current velocity and phase; only clamp at the speed limit.
      momentum = Math.min(physics.maxSpeed, Math.max(physics.inputMinSpeed, momentum + physics.inputImpulse));
    };
    const draw = (now: number) => {
      frameId = requestAnimationFrame(draw);
      if (isDragActive() || document.visibilityState !== "visible" || now - lastDrawn < FRAME_MS) return;
      lastDrawn = now;
      if (!composer?.isConnected) {
        const frame = [...document.querySelectorAll<HTMLElement>(`.quick-input.${config.skinClass}`)]
          .find(element => element.dataset.windowId === windowId);
        composer = frame?.querySelector<HTMLElement>(".chat-composer-stack") ?? null;
      }
      if (!composer) return;
      const nextInput = input?.isConnected ? input : composer.querySelector<HTMLElement>("textarea, [contenteditable='true']");
      if (nextInput !== input) {
        input?.removeEventListener("input", onInput);
        for (const name of ["keyup", "click", "select", "scroll", "focus", "blur"]) input?.removeEventListener(name, markCaretDirty);
        input = nextInput;
        if (skin === "gold" || skin === "water") input?.addEventListener("input", onInput);
        if (skin === "water") for (const name of ["keyup", "click", "select", "scroll", "focus", "blur"]) input?.addEventListener(name, markCaretDirty);
        caretDirty = true;
      }
      if (canvas.parentElement !== composer) composer.appendChild(canvas);
      if (dragon && dragon.parentElement !== composer) composer.appendChild(dragon);
      const cardWidth = composer.offsetWidth, cardHeight = composer.offsetHeight;
      const pad = config.pad(cardHeight), width = cardWidth + pad * 2, height = cardHeight + pad * 2;
      const ratio = Math.min(devicePixelRatio || 1, 2);
      if (width !== lastWidth || height !== lastHeight || canvas.width !== Math.round(width * ratio)) {
        lastWidth = width; lastHeight = height;
        canvas.style.left = `${-pad}px`; canvas.style.top = `${-pad}px`;
        canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
        canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
        gl.viewport(0, 0, canvas.width, canvas.height);
        radius = parseFloat(getComputedStyle(composer).borderRadius) || 20;
        caretDirty = true;
      }
      if (skin === "water") {
        if (caretDirty && input instanceof HTMLTextAreaElement && document.activeElement === input) {
          const point = caretPoint(input), rect = composer.getBoundingClientRect();
          const scaleX = rect.width / cardWidth || 1, scaleY = rect.height / cardHeight || 1;
          waterCaret = [pad + (point.x - rect.left) / scaleX, pad + (point.y - rect.top) / scaleY];
          if (pendingWaterPress) { pressCaret = waterCaret; pendingWaterPress = false; }
          caretDirty = false;
        }
        const elapsed = lastWaterAt ? Math.min((now - lastWaterAt) / 1000, .1) : 0;
        lastWaterAt = now;
        waterTime = (waterTime + elapsed * (paramsRef.current.waterParams?.intensity ?? 1)) % 1000;
        const steps = Math.max(1, Math.ceil(elapsed / .016));
        const dt = elapsed / steps;
        for (let i = 0; i < steps; i++) {
          waterVelocity += (-22 * waterActivity - 7 * waterVelocity) * dt;
          waterActivity += waterVelocity * dt;
          if (waterActivity < 0) { waterActivity = 0; waterVelocity = Math.max(0, waterVelocity); }
          if (waterActivity > 1) { waterActivity = 1; waterVelocity = Math.min(0, waterVelocity); }
        }
      }
      if (skin === "gold") {
        const elapsed = lastMotionAt ? Math.min((now - lastMotionAt) / 1000, 10) : 0;
        lastMotionAt = now;
        const speed = paramsRef.current.goldParams?.speed ?? 1;
        if ((momentum <= physics.fadeOutSpeed || timeoutHidden) && now >= idleStart) {
          momentum = physics.idleInitialSpeed;
          inputDriven = false;
          trailLength = 0;
          waveAge = 0;
          idleAngle = Math.random() * 10000;
          nextParticleAt = idleAngle;
          lastForceAt = now;
          timeoutHidden = false;
        }
        // Exact integration of dv/dt = -friction - drag*v²; independent of frame rate.
        const drag = Number(physics.velocityDrag);
        const velocityScale = drag > 0 ? Math.sqrt(physics.friction / drag) : 0;
        const decayRate = Math.sqrt(physics.friction * drag);
        const stopTime = drag > 0
          ? Math.atan(momentum / velocityScale) / decayRate
          : momentum / physics.friction;
        const movingTime = inputDriven ? Math.min(elapsed, stopTime) : elapsed;
        const nextVelocity = !inputDriven
          ? Math.max(0, momentum - physics.idleDeceleration * movingTime)
          : drag > 0
          ? velocityScale * Math.tan(Math.max(0, Math.atan(momentum / velocityScale) - decayRate * movingTime))
          : Math.max(0, momentum - physics.friction * movingTime);
        const travel = !inputDriven
          ? (momentum + nextVelocity) * .5 * movingTime
          : drag > 0
          ? Math.log((physics.friction + drag * momentum * momentum) / (physics.friction + drag * nextVelocity * nextVelocity)) / (2 * drag)
          : momentum * movingTime - .5 * physics.friction * movingTime * movingTime;
        const previousAngle = idleAngle;
        idleAngle += travel * speed;
        trailLength = Math.min(180, trailLength + travel * speed);
        if (!timeoutHidden && now - lastForceAt < (inputDriven ? physics.maxNoInputSeconds : physics.idleMaxSeconds) * 1000) {
          if (nextParticleAt < previousAngle) nextParticleAt = previousAngle;
          while (nextParticleAt <= idleAngle) {
            if (Math.random() < .5 + .35 * Math.min(1, momentum / physics.maxSpeed)) {
              particles.push({ along: nextParticleAt, born: now, vx: Math.random() * 8 - 4, vy: 5 + Math.random() * 7 });
            }
            nextParticleAt += 12;
          }
        }
        flowTime = (flowTime + travel * speed / 145) % 1000;
        const wasVisible = momentum > physics.fadeOutSpeed;
        momentum = nextVelocity;
        waveAge += movingTime;
        const fade = Math.max(0, Math.min(1, (momentum - physics.fadeOutSpeed) / (physics.fullVisibilitySpeed - physics.fadeOutSpeed)));
        const timeRemaining = (inputDriven ? physics.maxNoInputSeconds : physics.idleMaxSeconds) - (now - lastForceAt) / 1000;
        const timeFade = Math.max(0, Math.min(1, timeRemaining / physics.timeoutFadeSeconds));
        idleActivity = Math.min(1, waveAge / physics.fadeInSeconds) * fade * fade * (3 - 2 * fade)
          * timeFade * timeFade * (3 - 2 * timeFade) * physics.peakOpacity;
        if (wasVisible && momentum <= physics.fadeOutSpeed) idleStart = now + physics.idleGapMinMs + Math.random() * physics.idleGapRandomMs;
        if (!timeoutHidden && timeRemaining <= 0) {
          timeoutHidden = true;
          idleStart = now + physics.idleGapMinMs + Math.random() * physics.idleGapRandomMs;
        }
      }
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const flowActivity = 0;
      particles = particles.filter(p => now - p.born < 1800).slice(-32);
      const particleData = new Float32Array(32 * 4);
      particleData.fill(-1);
      particles.forEach((p, i) => particleData.set([p.along, (now - p.born) / 1000, p.vx, p.vy], i * 4));
      config.draw({ gl, uniform, now, cardWidth, cardHeight, pad, ratio, composer, radius,
        ...paramsRef.current, flowTime, flowActivity, idleAngle, idleActivity, trailLength,
        trailStrength: Math.min(1, momentum / physics.maxSpeed), particles: particleData, waterTime, waterActivity, waterCaret: pressCaret,
        waterCaretVisible: skin === "water" && document.activeElement === input ? 1 : 0 });
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    frameId = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frameId);
      input?.removeEventListener("input", onInput);
      for (const name of ["keyup", "click", "select", "scroll", "focus", "blur"]) input?.removeEventListener(name, markCaretDirty);
      canvas.remove(); dragon?.remove();
      if (waterImage) waterImage.onload = null;
      if (texture) gl.deleteTexture(texture);
      gl.deleteBuffer(quad); gl.deleteProgram(program); gl.deleteShader(vertex); gl.deleteShader(fragment);
    };
  }, [skin, windowId]);
  return null;
}
