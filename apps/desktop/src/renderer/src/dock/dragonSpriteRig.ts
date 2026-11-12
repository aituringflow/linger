import manifest from "./dragonSpriteManifest.json";

const displayWidth = 155;
const displayHeight = 97;
const sx = displayWidth / manifest.size.width;
const sy = displayHeight / manifest.size.height;
type SpriteName = keyof typeof manifest.sprites;
type Matrix = [number, number, number, number, number, number];

/** 小龙盒子（= .dragon-pet 的 155×97）在屏幕上的尺寸，喷口/旋转原点都按它算。 */
export const DRAGON_BOX = { width: displayWidth, height: displayHeight };

/**
 * 喷口在**小龙盒子坐标系**里的位置（左上角原点，单位 CSS px）。
 *
 * 以前这里是两个写死的小数字（44 / 43），对着 mouth-open 的裁切框算错了 ——
 * 火焰其实是从下巴/脸颊侧面冒出来的，不是从上下颚之间。
 * 现在改成由精灵清单推导：mouth-open 那张图的裁切框（431,274）加上「张开的口腔中心」
 * 在裁切图里的像素坐标，再乘精灵缩放。以后美术换了图、改了裁切框都不会再错位。
 */
const MOUTH_PIXEL_IN_CROP = { x: 168, y: 148 }; // mouth-open.png（449×321）里上下颚之间的开口中心
const mouthBox = manifest.sprites["mouth-open"];
export const DRAGON_MOUTH = {
  x: (mouthBox.x + MOUTH_PIXEL_IN_CROP.x) * sx,
  y: (mouthBox.y + MOUTH_PIXEL_IN_CROP.y) * sy,
};

const identity: Matrix = [1, 0, 0, 1, 0, 0];
const leftFold: Matrix = [.45437616, -.53179037, .07635009, .55174248, 0, 40 * sy];
const rightFold: Matrix = [.45437616, .53179037, -.07635009, .55174248, 0, 45 * sy];

function wingMatrix(from: Matrix, spread: number, side: -1 | 1, flutter: number) {
  // The former half-open pose is the new resting pose. The final pose extends
  // another 18% beyond the source's fully spread drawing.
  const pose = .5 + spread * .68;
  const values = from.map((value, index) => value + (identity[index] - value) * pose);
  // Bury the attachment under the shoulder sprite instead of leaving a dark
  // slit as the two differently painted source poses separate.
  values[4] += -side * 28 * sx;
  values[5] -= 10 * sy;
  values[3] += flutter;
  return `matrix(${values.join(",")})`;
}

function smooth(value: number) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

function sprite(parent: HTMLElement, name: SpriteName, hinge?: [number, number]) {
  const box = manifest.sprites[name];
  const image = document.createElement("img");
  image.className = "dragon-pet-sprite";
  image.alt = "";
  image.draggable = false;
  image.src = `pets/sprites/${box.file}`;
  image.style.left = `${box.x * sx}px`;
  image.style.top = `${box.y * sy}px`;
  image.style.width = `${box.width * sx}px`;
  image.style.height = `${box.height * sy}px`;
  if (hinge) image.style.transformOrigin = `${(hinge[0] - box.x) * sx}px ${(hinge[1] - box.y) * sy}px`;
  parent.append(image);
  return image;
}

/** Each displayed frame reuses a torso, head, paws, and two independently posed wings. */
export function createDragonSpriteRig(back: HTMLElement, front: HTMLElement) {
  const leftOpen = sprite(back, "wing-left-spread", [550, 505]);
  const rightOpen = sprite(back, "wing-right-spread", [1030, 500]);
  const leftShoulder = sprite(back, "wing-left-shoulder");
  sprite(back, "wing-right-shoulder");
  sprite(back, "torso");
  const headProfile = sprite(back, "head-static");
  const mouthClosed = sprite(back, "mouth-closed");
  const mouthOpen = sprite(back, "mouth-open");
  const headThreeQuarter = sprite(back, "head-three-quarter");
  const headFront = sprite(back, "head-front");
  sprite(front, "paws-front");

  return {
    draw(spread: number, mouth: number, time: number, reducedMotion = false, headTurn = 0) {
      const flutter = reducedMotion ? 0 : Math.sin(time * .004) * .006 * smooth((spread - .86) / .14);
      leftOpen.style.transform = wingMatrix(leftFold, spread, -1, flutter);
      rightOpen.style.transform = wingMatrix(rightFold, spread, 1, flutter);
      const turn = Math.max(0, Math.min(1, headTurn));
      // The original left shoulder crop contains part of the profile face.
      // Retire it with that face so it cannot remain as a second head.
      leftShoulder.style.opacity = `${1 - smooth((turn - .12) / .3)}`;
      // Keep the hand-painted key views readable. Narrow hand-offs avoid the
      // long translucent double image that a full-range crossfade produces.
      const firstBlend = smooth((turn - .38) / .08);
      const secondBlend = smooth((turn - .86) / .08);
      const profileOpacity = 1 - firstBlend;
      headProfile.style.opacity = `${profileOpacity}`;
      mouthClosed.style.opacity = `${profileOpacity * (1 - mouth)}`;
      mouthOpen.style.opacity = `${profileOpacity * mouth}`;
      headThreeQuarter.style.opacity = `${firstBlend * (1 - secondBlend)}`;
      headFront.style.opacity = `${secondBlend}`;
    },
  };
}
