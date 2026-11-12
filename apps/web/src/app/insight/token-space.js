'use client';

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Fixed locations and examples make the visual metaphor reproducible; this is not inference.
const TOKENS = [
  // 语义接近的词放在相邻区域；坐标均为示意。
  { word: '苹果', position: [2.25, 1.15, .2] },
  { word: '香蕉', position: [3.0, .75, -.25] },
  { word: '梨', position: [2.35, .3, .65] },
  { word: '葡萄', position: [3.25, 1.55, -.5] },
  { word: '森林', position: [-2.25, 1.15, .2] },
  { word: '树木', position: [-3.0, .75, -.25] },
  { word: '花草', position: [-2.35, .3, .65] },
  { word: '河流', position: [-3.25, 1.55, -.5] },
  { word: '喜欢', position: [.5, 2.2, .1] },
  { word: '想', position: [-.3, 2.5, -.2] },
  { word: '要', position: [1.3, 2.35, -.4] },
  { word: '吃', position: [1.05, -.85, .7] },
  { word: '喝', position: [1.75, -1.45, 0] },
  { word: '看', position: [.3, -1.5, -.5] },
  { word: '有', position: [-.85, -.85, .7] },
  { word: '是', position: [-1.55, -1.45, 0] },
  { word: '的', position: [-.25, -1.9, -.6] },
  { word: '和', position: [.1, .25, -1.5] },
  { word: '也', position: [.8, .1, -1.8] },
  { word: '因为', position: [-.65, .05, -1.8] },
  { word: '睡觉', position: [0, -2.15, -2] },
];
const PROBABILITIES = [65, 25, 10];
const COLORS = ['#a21b22', '#cf5734', '#b48630'];
const EXAMPLES = [
  { name: '饮食', steps: ['我', '我喜欢', '我喜欢吃', '我喜欢吃苹果'] },
  { name: '自然', steps: ['这里', '这里有', '这里有森林', '这里有森林和'] },
];
const STATES = {
  '我': { candidates: ['喜欢', '想', '要'], note: '从“我”开始，可以表达偏好或意愿。' },
  '我喜欢': { candidates: ['吃', '喝', '看'], note: '“喜欢”之后，可能接不同的活动。' },
  '我喜欢吃': { candidates: ['苹果', '香蕉', '梨'], note: '语境指向食物，相近的水果聚在一处。' },
  '我喜欢吃苹果': { candidates: ['和', '也', '因为'], note: '句子可以继续补充、并列或解释。' },
  '这里': { candidates: ['有', '是', '的'], note: '“这里”可以接存在、判断等表达。' },
  '这里有': { candidates: ['森林', '树木', '花草'], note: '语境指向自然，相近的事物聚在另一处。' },
  '这里有森林': { candidates: ['和', '也', '因为'], note: '两条不同的输入路径也可以指向共享的词。' },
  '这里有森林和': { candidates: ['树木', '花草', '河流'], note: '语境继续描述自然，候选回到自然区域。' },
};
function getState(value) {
  const input = value.replace(/\s/g, '');
  if (!input) return { type: 'empty', candidates: [] };
  if (STATES[input]) return { type: 'example', ...STATES[input] };
  return { type: 'unknown', candidates: [] };
}
function makeLabel(text) {
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 192;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(material); sprite.scale.set(1.65, .62, 1); sprite.renderOrder = 2;
  let lastRank = null;
  function update(rank) {
    if (rank === lastRank) return;
    lastRank = rank;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = rank >= 0 ? COLORS[rank] : '#777777';
    ctx.font = rank >= 0 ? '700 62px system-ui, sans-serif' : '500 54px system-ui, sans-serif';
    ctx.fillText(text, 256, rank >= 0 ? 76 : 105);
    if (rank >= 0) { ctx.font = '600 40px system-ui, sans-serif'; ctx.fillText(PROBABILITIES[rank] + '%', 256, 145); }
    texture.needsUpdate = true;
  }
  update(-1);
  return { sprite, update };
}
function Scene({ current }) {
  const host = useRef(null); const stateRef = useRef(current);
  useEffect(() => { stateRef.current = current; }, [current]);
  useEffect(() => {
    const element = host.current;
    let renderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); }
    catch { element.dataset.error = 'true'; element.querySelector('.scene-hint')?.remove(); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0xf5f5f3, 1); element.querySelector('.scene-hint')?.remove(); element.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, .1, 100); camera.position.set(0, 1.6, 12);
    const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.enablePan = false; controls.minDistance = 5; controls.maxDistance = 15; controls.autoRotate = false;
    const grid = new THREE.GridHelper(9, 18, 0xbcbcbc, 0xdddddd); grid.material.transparent = true; grid.material.opacity = .6; grid.position.y = -2.15; scene.add(grid);
    const axes = new THREE.AxesHelper(2.8); axes.material.transparent = true; axes.material.opacity = .18; scene.add(axes);
    const origin = new THREE.Mesh(new THREE.SphereGeometry(.075, 16, 12), new THREE.MeshBasicMaterial({ color: 0x333333 })); scene.add(origin);
    const geometry = new THREE.SphereGeometry(.07, 16, 12);
    const points = TOKENS.map(({ word, position }) => {
      const group = new THREE.Group(); group.position.set(...position);
      const dot = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0x999999 })); group.add(dot);
      const label = makeLabel(word); label.sprite.position.set(0, .42, 0); group.add(label.sprite); scene.add(group);
      return { word, dot, label };
    });
    const direction = new THREE.Vector3(1, 0, 0); const target = new THREE.Vector3();
    const arrow = new THREE.ArrowHelper(direction, new THREE.Vector3(), .01, 0x222222, .3, .18); arrow.visible = false; scene.add(arrow);
    const resize = () => { const w = element.clientWidth, h = element.clientHeight; if (!w || !h) return; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); };
    const observer = new ResizeObserver(resize); observer.observe(element); resize();
    let previous = performance.now(), frame;
    const render = now => {
      const elapsed = Math.min((now - previous) / 1000, .1); previous = now;
      const state = stateRef.current; const hasTarget = state.type === 'example';
      // 指向三个候选向量的概率加权中心：更靠近 65% 的词，但不落在它上面
      let wx = 0, wy = 0, wz = 0, weight = 0;
      if (hasTarget) {
        state.candidates.forEach((word, index) => {
          const item = TOKENS.find(token => token.word === word);
          if (!item) return;
          const w = PROBABILITIES[index] ?? 0;
          wx += item.position[0] * w; wy += item.position[1] * w; wz += item.position[2] * w; weight += w;
        });
      }
      target.set(weight ? wx / weight : 0, weight ? wy / weight : 0, weight ? wz / weight : 0);
      direction.lerp(target, 1 - Math.exp(-5 * elapsed));
      const length = direction.length(); arrow.visible = hasTarget || length > .05;
      if (length > .001) { arrow.setDirection(direction.clone().normalize()); arrow.setLength(length, Math.min(.35, length * .3), Math.min(.19, length * .15)); }
      points.forEach(({ word, dot, label }) => { const rank = state.candidates.indexOf(word); dot.material.color.set(rank >= 0 ? COLORS[rank] : '#a5a5a5'); dot.scale.setScalar(rank >= 0 ? 1.5 : 1); label.update(rank); });
      controls.update(); renderer.render(scene, camera); frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); controls.dispose(); geometry.dispose(); grid.geometry.dispose(); grid.material.dispose(); axes.geometry.dispose(); axes.material.dispose(); origin.geometry.dispose(); origin.material.dispose(); points.forEach(({dot,label}) => { dot.material.dispose(); label.sprite.material.map.dispose(); label.sprite.material.dispose(); }); arrow.line.geometry.dispose(); arrow.line.material.dispose(); arrow.cone.geometry.dispose(); arrow.cone.material.dispose(); renderer.dispose(); renderer.domElement.remove(); };
  }, []);
  return <div className="token-canvas" ref={host}><p className="scene-hint">语义空间 · 场景载入中</p><p className="webgl-fallback">当前浏览器无法显示 三维场景，可使用右侧示例查看候选词。</p></div>;
}
export default function TokenSpace() {
  const [value, setValue] = useState(''); const current = getState(value);
  return <section className="token-demo" aria-label="向量空间交互示意"><div className="demo-layout"><div className="demo-scene"><div className="demo-scene-label"><span>语义空间</span></div><Scene current={current}/></div><div className="demo-controls"><label htmlFor="token-input">输入一句话 <span>输入</span></label><input id="token-input" value={value} onChange={event => setValue(event.target.value.slice(0, 30))} placeholder="试着输入「我」或「这里」" autoComplete="off"/><p className="input-hint">点击每一行的四个步骤，观察输入增加后向量与候选词的变化。</p><div className="demo-examples">{EXAMPLES.map(example => <div className="demo-example-row" key={example.name}><span>{example.name}</span><div>{example.steps.map((text, index) => <button type="button" key={text} className={value===text?'active':''} onClick={() => setValue(text)} aria-label={example.name + '示例，第' + (index+1) + '步：' + text}>{text}</button>)}</div></div>)}<button type="button" className="demo-reset" onClick={() => setValue('')}>清空</button></div><div className="candidate-area" aria-live="polite"><div className="candidate-heading"><span>可能的下一个词</span><small>示意概率 · 合计 100%</small></div>{current.type === 'empty' ? <p className="candidate-placeholder">输入文字后，向量会从中心指向一组候选词。</p> : current.type === 'unknown' ? <p className="candidate-placeholder">这是预设演示，请选择上方饮食或自然示例的四个步骤。</p> : <><div className="candidate-list">{current.candidates.map((word,index) => <span key={word} style={{ color: COLORS[index], borderColor: COLORS[index] }}><small style={{ color: COLORS[index] }}>{PROBABILITIES[index]}%</small>{word}</span>)}</div><p className="candidate-note">{current.note}</p></>}</div><p className="demo-disclaimer">概念演示：词的位置、方向与概率均为预设示意：相近词在图中靠近，并非真实模型的坐标或预测。真实大模型通过词表打分与解码生成结果；箭头停在候选的概率加权中心，不落在概率最高的那个词上。</p></div></div></section>;
}
