/**
 * Shared procedural fuel field and heat palette for the composer rim and dragon breath.
 *
 * ⚠️ time 的量级（踩过坑，别改回去）：
 * hash() 是 fract(sin(dot(p, k)) * 43758.5453)。sin 的参数大到一定程度后，GPU 的 fp32
 * 参数归约精度不够，sin 退化成常数，hash 随之退化 —— 整片噪声场变成一张纯色（实测
 * |dot| ≳ 5e7 时空间方差直接归零）。而 time 是「进程启动至今的秒数」，坐标只增不减，
 * 所以 launcher 挂久了火焰就会「变淡 → 彻底静止 → 只剩描边」，这不是参数问题，是精度问题。
 *
 * 三条硬约束，改动噪声时都必须满足：
 * 1. 进噪声的时间项必须回绕到小范围：统一用 fireTime() 取 (elapsed % FIRE_TIME_WRAP)。
 * 2. 回绕必须无缝：noiseW / fbmW 把 y 方向网格按整数周期取模，让场本身严格周期自重复，
 *    于是 time 从 WRAP 跳回 0 时，画面位移恰好等于一帧的正常滚动量，肉眼无跳变。
 * 3. 倍频用整数倍率（2/4/8）而不是 2.13/4.37/8.21：每个倍频的周期都得是整数，
 *    非整数周期会让该倍频在接缝处残留相位跳变。
 */

/** 输入卡火焰的时间回绕周期（秒）。取 300 是因为 3.9/5.8/1.15/1.5 乘它都是整数格。 */
export const FIRE_TIME_WRAP = 300;

/** 小龙喷火的时间回绕周期（秒）。喷火只有 ~1.15s，更小的周期就够，且它的滚动速度快得多。 */
export const DRAGON_TIME_WRAP = 60;

/** 各层噪声沿 y 的滚动速度（格/秒），与 DynamicComposer 里的 time 乘数一致。 */
export const FIRE_SCROLL = { detail: 3.9, texture: 5.8, fuel: 1.15, drift: 1.5 } as const;

/** 各层在 y 方向的网格周期（格）：必须为整数，否则回绕接缝会露出来。 */
export const FIRE_LATTICE = {
  detail: Math.round(FIRE_SCROLL.detail * FIRE_TIME_WRAP),
  texture: Math.round(FIRE_SCROLL.texture * FIRE_TIME_WRAP),
  fuel: Math.round(FIRE_SCROLL.fuel * FIRE_TIME_WRAP),
  drift: Math.round(FIRE_SCROLL.drift * FIRE_TIME_WRAP),
};

/** 把「进程启动至今的毫秒数」换成有界、且能在 WRAP 处无缝接回 0 的 shader 时间。 */
export function fireTime(nowMs: number, wrap: number = FIRE_TIME_WRAP): number {
  return (nowMs * 0.001) % wrap;
}

export const FIRE_NOISE_GLSL = `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  return 0.52 * noise(p) + 0.28 * noise(p * 2.13 + 8.1)
       + 0.14 * noise(p * 4.37 - 3.7) + 0.06 * noise(p * 8.21 + 12.3);
}
float noiseW(vec2 p, float period) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float y0 = mod(i.y, period), y1 = mod(y0 + 1.0, period);
  return mix(mix(hash(vec2(i.x, y0)), hash(vec2(i.x + 1.0, y0)), f.x),
             mix(hash(vec2(i.x, y1)), hash(vec2(i.x + 1.0, y1)), f.x), f.y);
}
float fbmW(vec2 p, float period) {
  return 0.52 * noiseW(p, period)
       + 0.28 * noiseW(p * 2.0 + 8.1, period * 2.0)
       + 0.14 * noiseW(p * 4.0 - 3.7, period * 4.0)
       + 0.06 * noiseW(p * 8.0 + 12.3, period * 8.0);
}`;

export const FIRE_COLOR_GLSL = `
vec3 fireColor(float heat) {
  vec3 color = vec3(0.24, 0.014, 0.003);
  color = mix(color, vec3(0.78, 0.085, 0.008), smoothstep(0.12, 0.42, heat));
  color = mix(color, vec3(1.0, 0.34, 0.012), smoothstep(0.34, 0.68, heat));
  color = mix(color, vec3(1.0, 0.74, 0.12), smoothstep(0.62, 0.95, heat));
  color = mix(color, vec3(1.0, 0.94, 0.57), smoothstep(0.98, 1.35, heat));
  return color;
}`;

/**
 * 输入卡描边火焰的 fragment shader。
 * 放在这里（而不是组件里）是为了让 lab/fire-precision 的探针能编译「真实发布的那一份」，
 * 而不是另抄一份 —— 这个效果的回归只体现在长时间运行后，靠肉眼很难发现。
 */
export const BURNING_FRAGMENT_GLSL = `
  precision highp float;
  uniform vec2 resolution;
  uniform float pixelRatio;
  uniform float visualScale;
  uniform vec4 box;
  uniform float radius;
  uniform float time;
  uniform float intensity;
  uniform float topReach;
  uniform float sideReach;
  uniform float bottomReach;
  uniform float turbulence;
  ${FIRE_NOISE_GLSL}
  ${FIRE_COLOR_GLSL}
  float roundedBox(vec2 p) {
    vec2 q = abs(p - box.xy - box.zw * 0.5) - box.zw * 0.5 + radius;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
  }
  void main() {
    vec2 p = vec2(gl_FragCoord.x / pixelRatio, resolution.y - gl_FragCoord.y / pixelRatio) / visualScale;
    float rimDistance = roundedBox(p);
    float rim = exp(-abs(rimDistance) * 1.35) * 0.72;
    float transmission = 1.0, heatSum = 0.0, heatWeight = 0.0;
    float detail = fbmW(vec2(p.x * 0.16, p.y * 0.13 + time * ${FIRE_SCROLL.detail}), ${FIRE_LATTICE.detail}.0);
    float texture = fbmW(vec2(p.x * 0.23, p.y * 0.19 + time * ${FIRE_SCROLL.texture}), ${FIRE_LATTICE.texture}.0);
    float maxReach = max(max(topReach, sideReach), bottomReach);
    float offset = (noise(vec2(p.x * 0.17, 7.7)) - 0.5) * 1.8;
    for (int i = 0; i < 49; i++) {
      float rise = i == 0 ? 0.0 : float(i) * 2.0 + offset;
      if (rise > maxReach + 5.0) break;
      float drift = (noiseW(vec2(p.x * 0.027, (p.y + rise) * 0.029 + time * ${FIRE_SCROLL.drift}), ${FIRE_LATTICE.drift}.0) - 0.5)
                    * rise * 0.22 * turbulence;
      vec2 source = p + vec2(drift, rise);
      float distanceToWood = abs(roundedBox(source));
      float topBlend = 1.0 - smoothstep(box.y - 3.0, box.y + 17.0, source.y);
      float bottomBlend = smoothstep(box.y + box.w - 17.0, box.y + box.w + 3.0, source.y);
      float reach = mix(sideReach, topReach, topBlend);
      reach = mix(reach, bottomReach, bottomBlend);
      if (rise > reach + 5.0 || reach < 0.5) continue;
      float fuel = fbmW(vec2(source.x * 0.071, source.y * 0.058 + time * ${FIRE_SCROLL.fuel}), ${FIRE_LATTICE.fuel}.0);
      float life = reach * (0.47 + fuel * 0.44 + (detail - 0.5) * 0.33);
      float tip = 1.0 - smoothstep(life - 4.0, life + 2.0, rise);
      float proximity = exp(-distanceToWood / (3.2 + rise * 0.078));
      float pockets = 0.36 + 0.64 * smoothstep(0.24, 0.7, detail);
      float weight = tip * proximity * pockets * 0.32;
      transmission *= 1.0 - weight;
      heatSum += weight * (1.0 - rise / max(reach, 1.0) + (detail - 0.5) * 0.28);
      heatWeight += weight;
    }
    float flame = 1.0 - transmission;
    float interior = 1.0 - step(0.0, rimDistance);
    float lowerInterior = smoothstep(box.y + box.w - 31.0, box.y + box.w - 13.0, p.y);
    flame *= max(1.0 - interior, lowerInterior);
    // 边缘辉光带一个不随强度衰减的下限（0.45 + 0.55*intensity）：
    // 低强度时 rim 仍是可见的单条金线（输入卡自身 CSS 边框已移除，避免双线）。
    float rimA = rim * (0.45 + 0.55 * intensity);
    float alpha = clamp(max(flame * (0.68 + 0.44 * texture) * intensity, rimA), 0.0, 1.0);
    float heat = heatSum / max(heatWeight, 0.001) + rim * 0.48 + (texture - 0.5) * 0.18;
    gl_FragColor = vec4(fireColor(heat), alpha);
  }
`;
