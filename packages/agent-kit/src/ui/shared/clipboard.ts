/** Clipboard API with an execCommand fallback for hosts that deny clipboard permission. */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* Fall back to execCommand. */ }
  try {
    const input = document.createElement("textarea");
    input.value = text;
    input.style.position = "fixed";
    input.style.top = "0";
    input.style.left = "0";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.focus();
    input.select();
    const copied = document.execCommand("copy");
    input.remove();
    return copied;
  } catch {
    return false;
  }
}
