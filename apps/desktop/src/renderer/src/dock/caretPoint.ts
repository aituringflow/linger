/** Mirror the textarea's wrapping to locate its insertion caret in screen coordinates. */
export function caretPoint(input: HTMLTextAreaElement) {
  const computed = getComputedStyle(input);
  const mirror = document.createElement("div");
  const props = ["fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight", "textIndent", "tabSize", "wordSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "boxSizing", "wordBreak", "overflowWrap"] as const;
  for (const prop of props) mirror.style[prop] = computed[prop];
  mirror.style.cssText += `;position:fixed;left:-10000px;top:0;width:${input.offsetWidth}px;white-space:pre-wrap;overflow:hidden;visibility:hidden`;
  mirror.textContent = input.value.slice(0, input.selectionStart);
  const marker = document.createElement("span");
  marker.textContent = input.value.charAt(input.selectionStart) || "\u200b";
  mirror.append(marker);
  document.body.append(mirror);
  const a = marker.getBoundingClientRect(), b = mirror.getBoundingClientRect(), c = input.getBoundingClientRect();
  const result = { x: c.left + a.left - b.left - input.scrollLeft, y: c.top + a.top - b.top - input.scrollTop + (parseFloat(computed.lineHeight) || 24) / 2 };
  mirror.remove();
  return result;
}

