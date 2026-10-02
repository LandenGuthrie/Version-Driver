import { useStore } from '../store';

/** Drag handle between the sidebar and the viewer. Double-click resets the width. */
export function Resizer() {
  const { sidebarWidth, setSidebarWidth } = useStore();
  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = sidebarWidth;
    const zoom = Number(document.documentElement.style.zoom) || 1;
    const move = (ev: PointerEvent) => setSidebarWidth(w0 + (ev.clientX - x0) / zoom);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'col-resize';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div
      className="resizer" role="separator" aria-orientation="vertical" aria-label="Resize sidebar" tabIndex={0}
      onPointerDown={start} onDoubleClick={() => setSidebarWidth(340)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') setSidebarWidth(sidebarWidth - 16);
        if (e.key === 'ArrowRight') setSidebarWidth(sidebarWidth + 16);
      }}
    >
      <i />
    </div>
  );
}
