import {
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";
import { Icon } from "./Icon.tsx";

export function CallWindow({
  children,
  title,
  status,
  group = false,
  kind,
  phase,
}: {
  children: ReactNode;
  title: string;
  status: ReactNode;
  group?: boolean;
  kind: string;
  phase: string;
}) {
  const [geometry, setGeometry] = useState(() => ({
    x: Math.max(12, innerWidth - (group ? 820 : 720) - 24),
    y: Math.max(12, innerHeight - 674),
    width: Math.min(group ? 820 : 720, innerWidth - 24),
    height: Math.min(
      kind === "audio" ? 480 : group ? 650 : 600,
      innerHeight - 24,
    ),
  }));
  const [maximized, setMaximized] = useState(false),
    [minimized, setMinimized] = useState(false);
  const motion = useRef<
    { x: number; y: number; box: typeof geometry; resize: boolean } | undefined
  >(undefined);
  const clamp = (box: typeof geometry) => ({
    width: Math.max(
      Math.min(320, innerWidth - 24),
      Math.min(box.width, innerWidth - 24),
    ),
    height: Math.max(
      Math.min(260, innerHeight - 24),
      Math.min(box.height, innerHeight - 24),
    ),
    x: Math.max(
      12,
      Math.min(box.x, innerWidth - Math.min(box.width, innerWidth - 24) - 12),
    ),
    y: Math.max(
      12,
      Math.min(
        box.y,
        innerHeight - Math.min(box.height, innerHeight - 24) - 12,
      ),
    ),
  });
  useEffect(() => {
    const resize = () => setGeometry((box) => clamp(box));
    addEventListener("resize", resize);
    return () => removeEventListener("resize", resize);
  }, []);
  const begin = (event: PointerEvent<HTMLElement>, resize = false) => {
    if (
      maximized ||
      (!resize && (event.target as HTMLElement).closest("button"))
    )
      return;
    const bounds = event.currentTarget
      .closest(".call-panel")!
      .getBoundingClientRect();
    motion.current = {
      x: event.clientX,
      y: event.clientY,
      box: {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      },
      resize,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    const drag = motion.current;
    if (!drag) return;
    const dx = event.clientX - drag.x,
      dy = event.clientY - drag.y;
    setGeometry(
      clamp(
        drag.resize
          ? {
              ...drag.box,
              width: drag.box.width + dx,
              height: drag.box.height + dy,
            }
          : { ...drag.box, x: drag.box.x + dx, y: drag.box.y + dy },
      ),
    );
  };
  const box = maximized
    ? {
        left: 12,
        top: 12,
        width: "calc(100vw - 24px)",
        height: "calc(100dvh - 24px)",
      }
    : {
        left: `clamp(12px, ${geometry.x}px, calc(100vw - min(${geometry.width}px, calc(100vw - 24px)) - 12px))`,
        top: `clamp(12px, ${geometry.y}px, calc(100dvh - min(${geometry.height}px, calc(100dvh - 24px)) - 12px))`,
        width: geometry.width,
        height: minimized ? undefined : geometry.height,
      };
  return (
    <section
      className={
        "call-panel floating-call " +
        (group ? "group-call-panel " : "") +
        (minimized ? "minimized" : "")
      }
      aria-label={group ? "Cuộc gọi nhóm" : "Cuộc gọi"}
      data-kind={kind}
      data-phase={phase}
      style={box}
    >
      <div
        className="call-window-bar"
        onPointerDown={begin}
        onPointerMove={move}
        onPointerUp={() => {
          motion.current = undefined;
        }}
        onPointerCancel={() => {
          motion.current = undefined;
        }}
      >
        <div
          className="call-window-title"
          tabIndex={0}
          role="button"
          aria-label="Di chuyển cửa sổ cuộc gọi bằng phím mũi tên"
          onKeyDown={(event) => {
            const directions: Record<string, [number, number]> = {
              ArrowLeft: [-20, 0],
              ArrowRight: [20, 0],
              ArrowUp: [0, -20],
              ArrowDown: [0, 20],
            };
            const delta = directions[event.key];
            if (delta && !maximized) {
              event.preventDefault();
              setGeometry((box) =>
                clamp({ ...box, x: box.x + delta[0], y: box.y + delta[1] }),
              );
            }
          }}
        >
          <strong>{title}</strong>
          <span role="status">{status}</span>
        </div>
        <div className="call-window-controls">
          <button
            className="icon-button"
            aria-label={minimized ? "Mở cửa sổ cuộc gọi" : "Thu gọn cuộc gọi"}
            onClick={() => setMinimized(!minimized)}
          >
            <Icon name={minimized ? "plus" : "minus"} size={17} />
          </button>
          <button
            className="icon-button"
            aria-label={
              maximized ? "Khôi phục kích thước cuộc gọi" : "Phóng to cuộc gọi"
            }
            onClick={() => {
              setMinimized(false);
              setMaximized(!maximized);
            }}
          >
            <Icon name="expand" size={17} />
          </button>
        </div>
      </div>
      <div className="call-window-content">{children}</div>
      {!maximized && !minimized && (
        <button
          className="call-resize"
          aria-label="Kéo để đổi kích thước cuộc gọi"
          onPointerDown={(event) => begin(event, true)}
          onPointerMove={move}
          onPointerUp={() => {
            motion.current = undefined;
          }}
          onPointerCancel={() => {
            motion.current = undefined;
          }}
          onKeyDown={(event) => {
            if (
              ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
                event.key,
              )
            ) {
              event.preventDefault();
              setGeometry((box) =>
                clamp({
                  ...box,
                  width:
                    box.width +
                    (event.key === "ArrowRight"
                      ? 20
                      : event.key === "ArrowLeft"
                        ? -20
                        : 0),
                  height:
                    box.height +
                    (event.key === "ArrowDown"
                      ? 20
                      : event.key === "ArrowUp"
                        ? -20
                        : 0),
                }),
              );
            }
          }}
        >
          ◢
        </button>
      )}
    </section>
  );
}
