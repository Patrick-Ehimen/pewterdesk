/**
 * Stops the page's text being selected while something is dragged across it
 * (a floating card moved or resized), and drops any selection already made.
 * Returns the function that lets selection work again; call it when the
 * drag ends.
 */
export function lockTextSelection(): () => void {
  const style = document.body.style;
  const before = { user: style.userSelect, webkit: style.webkitUserSelect };
  style.userSelect = "none";
  style.webkitUserSelect = "none";
  window.getSelection()?.removeAllRanges();
  return () => {
    style.userSelect = before.user;
    style.webkitUserSelect = before.webkit;
  };
}
