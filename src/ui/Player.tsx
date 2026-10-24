import { useEffect, useRef, useState } from 'preact/hooks';
import type { Gif } from '../api/types';
import { defaultStorage } from '../store/storage';
import { fitSize, readPlayerPrefs, updatePlayerPrefs, type ScaleMode } from './postPageHelpers';

/** Width of an element, kept up to date with a ResizeObserver (0 until measured). */
export function useElementWidth(): [(el: HTMLElement | null) => void, number] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return [setEl, width];
}

function useViewportHeight(): number {
  const [h, setH] = useState(() => (typeof window === 'undefined' ? 800 : window.innerHeight));
  useEffect(() => {
    const onResize = () => setH(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return h;
}

interface PlayerProps {
  gif: Gif;
  /** Tallest the media may be in Fit / Fit height modes; null = 85% of the viewport. */
  maxHeight?: number | null;
  /** Current scale mode (chosen in the sidebar's Display section) and how to change it. */
  scale: ScaleMode;
  onScale: (mode: ScaleMode) => void;
}

/** The post's media. Key it by post id so navigating to another post resets it. */
export function Player({ gif, maxHeight = null, scale, onScale }: PlayerProps) {
  const choose = onScale;
  const [boxRef, boxWidth] = useElementWidth();
  const viewport = useViewportHeight();
  const boxHeight = maxHeight ?? Math.round(viewport * 0.85);
  const size = fitSize(scale, { width: boxWidth, height: boxHeight }, { width: gif.width, height: gif.height });
  const style = size ? { width: `${size.width}px`, height: `${size.height}px` } : undefined;

  return (
    <div class="rgb-playerwrap">
      <div class={`rgb-player${gif.type === 2 ? ' image' : ''}`} ref={boxRef}>
        {gif.type === 2
          ? <ImagePlayer gif={gif} original={scale === 'original'} style={style} onToggle={() => choose(scale === 'original' ? 'fit' : 'original')} />
          : <VideoPlayer gif={gif} style={style} />}
      </div>
    </div>
  );
}

type MediaStyle = { width: string; height: string } | undefined;

function ImagePlayer({ gif, original, style, onToggle }: { gif: Gif; original: boolean; style: MediaStyle; onToggle: () => void }) {
  const src = gif.urls.hd ?? gif.urls.sd ?? gif.urls.poster;
  return src ? (
    <img
      class={original ? 'orig' : 'fit'}
      src={src}
      alt=""
      style={style}
      title={original ? 'Click to fit the window' : 'Click for original size'}
      onClick={onToggle}
    />
  ) : null;
}

function VideoPlayer({ gif, style }: { gif: Gif; style: MediaStyle }) {
  const ref = useRef<HTMLVideoElement>(null);
  // First visit (nothing saved): muted. Afterwards the saved muted state and volume are restored.
  const [prefs] = useState(() => readPlayerPrefs(defaultStorage()));
  const [src, setSrc] = useState(gif.urls.hd ?? gif.urls.sd);
  // volumechange also fires for our own changes below; those must not be saved as the user's choice.
  const ignoreUntil = useRef(0);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    ignoreUntil.current = Date.now() + 500;
    video.volume = prefs.volume;
    video.muted = prefs.muted;
    video.play?.()?.catch(() => {
      // Autoplay with sound can be refused; play muted instead (not remembered).
      if (!video.muted) {
        ignoreUntil.current = Date.now() + 500;
        video.muted = true;
      }
      video.play?.()?.catch(() => undefined);
    });
  }, []);

  return (
    <video
      ref={ref}
      controls
      loop
      autoplay
      playsInline
      muted={prefs.muted}
      poster={gif.urls.poster}
      src={src}
      style={{ ...(gif.avgColor ? { background: gif.avgColor } : {}), ...style }}
      onError={() => {
        if (gif.urls.sd && src !== gif.urls.sd) setSrc(gif.urls.sd);
      }}
      onVolumeChange={(event) => {
        if (Date.now() < ignoreUntil.current) return;
        const video = event.currentTarget as HTMLVideoElement;
        updatePlayerPrefs({ muted: video.muted, volume: video.volume }, defaultStorage());
      }}
    />
  );
}
