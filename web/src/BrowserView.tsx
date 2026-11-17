import { useEffect, useRef } from 'react';

interface Props {
  sessionId: string | null;
  viewport: { width: number; height: number };
  send: (m: unknown) => void;
  registerFrameSink: (fn: (data: string) => void) => void;
  mode: string;
}

/**
 * Remote browser viewer: renders the CDP screencast and forwards mouse and
 * keyboard input to the real Chromium page, where Playwright dispatches it as
 * trusted input (so the injected recorder sees genuine user events).
 */
export function BrowserView({ sessionId, viewport, send, registerFrameSink, mode }: Props) {
  const img = useRef<HTMLImageElement>(null);
  const lastMove = useRef(0);

  useEffect(() => {
    registerFrameSink((data) => { if (img.current) img.current.src = `data:image/jpeg;base64,${data}`; });
  }, [registerFrameSink]);

  const pos = (e: React.MouseEvent | React.WheelEvent) => {
    const r = img.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * viewport.width) / r.width, y: ((e.clientY - r.top) * viewport.height) / r.height };
  };
  const input = (ev: Record<string, unknown>) => sessionId && send({ t: 'input', sessionId, ev });
  const btn = (b: number) => (b === 2 ? 'right' : b === 1 ? 'middle' : 'left');

  if (!sessionId) {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-400 text-sm bg-slate-50 border border-dashed border-slate-300 rounded">
        Enter a URL and press Record to open a live browser here.
      </div>
    );
  }
  return (
    <div
      tabIndex={0}
      data-testid="browser-surface"
      className={`relative outline-none flex-1 min-h-0 flex items-start justify-center bg-slate-800 rounded overflow-hidden focus:ring-2 ${mode === 'assert' ? 'ring-2 ring-orange-400' : 'focus:ring-indigo-400'}`}
      onKeyDown={(e) => {
        e.preventDefault();
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && !/^[\x20-\x7e]$/.test(e.key)) input({ type: 'text', text: e.key });
        else input({ type: 'keydown', key: e.key });
      }}
      onKeyUp={(e) => { e.preventDefault(); if (!(e.key.length === 1 && !/^[\x20-\x7e]$/.test(e.key))) input({ type: 'keyup', key: e.key }); }}
      onPaste={(e) => { e.preventDefault(); input({ type: 'text', text: e.clipboardData.getData('text') }); }}
    >
      <img
        ref={img}
        alt="Remote browser"
        draggable={false}
        className="max-w-full max-h-full object-contain select-none bg-white cursor-default"
        style={{ aspectRatio: `${viewport.width}/${viewport.height}` }}
        onMouseMove={(e) => { const now = performance.now(); if (now - lastMove.current < 25 && e.buttons === 0) return; lastMove.current = now; input({ type: 'mousemove', ...pos(e) }); }}
        onMouseDown={(e) => { (e.currentTarget.parentElement as HTMLElement).focus(); e.preventDefault(); input({ type: 'mousedown', ...pos(e), button: btn(e.button), clickCount: e.detail || 1 }); }}
        onMouseUp={(e) => { e.preventDefault(); input({ type: 'mouseup', ...pos(e), button: btn(e.button), clickCount: e.detail || 1 }); }}
        onContextMenu={(e) => e.preventDefault()}
        onWheel={(e) => input({ type: 'wheel', ...pos(e), deltaX: e.deltaX, deltaY: e.deltaY })}
      />
      {mode === 'assert' && <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-orange-500 text-white text-xs px-3 py-1 rounded shadow">Click an element to add an assertion</div>}
      {mode === 'paused' && <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-amber-500 text-white text-xs px-3 py-1 rounded shadow">Recording paused: interactions are not captured</div>}
    </div>
  );
}
