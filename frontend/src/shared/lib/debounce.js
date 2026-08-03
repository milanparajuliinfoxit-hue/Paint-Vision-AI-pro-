export function debounce(fn, waitMs) {
  let timer = null;
  function debounced(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
  }
  debounced.cancel = () => clearTimeout(timer);
  return debounced;
}
