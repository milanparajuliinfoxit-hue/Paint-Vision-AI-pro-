import { useEffect, useState } from 'react';

const MAX_DIMENSION = 1600; // client-side downscale cap, keeps canvas ops fast

// Loads an <img> and returns it pre-decoded, downscaled to a sane working
// size (full-res stays on the server for export — requirements doc, Section
// 11's "virtualize/lazy-load high-res source images" guidance).
export function useImageElement(url) {
  const [state, setState] = useState({ image: null, width: 0, height: 0, loading: !!url, error: null });

  useEffect(() => {
    if (!url) {
      setState({ image: null, width: 0, height: 0, loading: false, error: null });
      return undefined;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (cancelled) return;
      const scale = Math.min(1, MAX_DIMENSION / Math.max(img.width, img.height));
      setState({
        image: img,
        width: Math.round(img.width * scale),
        height: Math.round(img.height * scale),
        loading: false,
        error: null,
      });
    };
    img.onerror = () => !cancelled && setState({ image: null, width: 0, height: 0, loading: false, error: new Error('Image failed to load') });
    img.src = url;

    return () => { cancelled = true; };
  }, [url]);

  return state;
}
