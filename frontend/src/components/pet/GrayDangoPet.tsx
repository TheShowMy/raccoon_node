import {
  memo,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import {
  GRAYDANGO_DRAG_ANIMATIONS,
  grayDangoDirectionCell,
  type GrayDangoDirectionCell,
  type GrayDangoPresentation,
} from "./graydangoModel";
import {
  DEFAULT_GRAYDANGO_POSITION,
  grayDangoDragDirection,
  grayDangoPositionForPointer,
  GRAYDANGO_DIRECTION_DEADZONE,
  GRAYDANGO_POSITION_STORAGE_KEY,
  parseGrayDangoPosition,
  type GrayDangoDragDirection,
  type GrayDangoPosition,
} from "./graydangoPosition";
import "./graydango.css";

type SpriteStyle = CSSProperties & {
  "--graydango-x": string;
  "--graydango-y": string;
};

type DragSession = {
  pointerId: number;
  container: { left: number; top: number; width: number; height: number };
  pet: { width: number; height: number };
  grabOffset: { x: number; y: number };
  directionAnchorX: number;
};

function loadPosition() {
  if (typeof window === "undefined") return DEFAULT_GRAYDANGO_POSITION;
  try {
    return parseGrayDangoPosition(
      window.localStorage.getItem(GRAYDANGO_POSITION_STORAGE_KEY),
    );
  } catch {
    return DEFAULT_GRAYDANGO_POSITION;
  }
}

function savePosition(position: GrayDangoPosition) {
  try {
    window.localStorage.setItem(
      GRAYDANGO_POSITION_STORAGE_KEY,
      JSON.stringify(position),
    );
  } catch {
    // Storage may be unavailable in private or locked-down browser contexts.
  }
}

function GrayDangoPet({
  presentation,
  containerRef,
}: {
  presentation: GrayDangoPresentation;
  containerRef: RefObject<HTMLElement | null>;
}) {
  const [position, setPosition] = useState(loadPosition);
  const positionRef = useRef(position);
  const pendingPositionRef = useRef<GrayDangoPosition | null>(null);
  const positionFrameRef = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);
  const [dragDirection, setDragDirection] =
    useState<GrayDangoDragDirection>("right");
  const dragDirectionRef = useRef<GrayDangoDragDirection>("right");
  const dragSessionRef = useRef<DragSession | null>(null);
  const [frame, setFrame] = useState(0);
  const [lookDirection, setLookDirection] =
    useState<GrayDangoDirectionCell | null>(null);
  const petRef = useRef<HTMLElement>(null);
  const spriteRef = useRef<HTMLSpanElement>(null);
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const dragAnimation = dragging
    ? GRAYDANGO_DRAG_ANIMATIONS[dragDirection]
    : null;
  const activeAnimation = dragging
    ? `running-${dragDirection}`
    : presentation.animation;
  const activeFrames = dragAnimation?.frames ?? presentation.frames;

  useEffect(() => {
    setFrame(0);
    if (reduceMotion) return;
    const interval = window.setInterval(
      () => setFrame((current) => (current + 1) % activeFrames),
      180,
    );
    return () => window.clearInterval(interval);
  }, [activeAnimation, activeFrames, reduceMotion]);

  useEffect(() => {
    if (presentation.animation !== "idle") {
      setLookDirection(null);
      return;
    }
    let animationFrame = 0;
    const onPointerMove = (event: PointerEvent) => {
      if (draggingRef.current) return;
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        const bounds = spriteRef.current?.getBoundingClientRect();
        if (!bounds) return;
        const centerX = bounds.left + bounds.width / 2;
        const centerY = bounds.top + bounds.height / 2;
        setLookDirection(
          grayDangoDirectionCell(
            event.clientX - centerX,
            event.clientY - centerY,
            Math.min(bounds.width, bounds.height) * 0.75,
          ),
        );
      });
    };
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("pointermove", onPointerMove);
    };
  }, [presentation.animation]);

  useEffect(
    () => () => {
      if (positionFrameRef.current !== null) {
        window.cancelAnimationFrame(positionFrameRef.current);
      }
    },
    [],
  );

  const schedulePosition = (next: GrayDangoPosition) => {
    positionRef.current = next;
    pendingPositionRef.current = next;
    if (positionFrameRef.current !== null) return;
    positionFrameRef.current = window.requestAnimationFrame(() => {
      positionFrameRef.current = null;
      const pending = pendingPositionRef.current;
      pendingPositionRef.current = null;
      if (pending) setPosition(pending);
    });
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const container = containerRef.current;
    const pet = petRef.current;
    if (!container || !pet) return;
    event.preventDefault();
    event.stopPropagation();

    const containerBounds = container.getBoundingClientRect();
    const petBounds = pet.getBoundingClientRect();
    dragSessionRef.current = {
      pointerId: event.pointerId,
      container: {
        left: containerBounds.left,
        top: containerBounds.top,
        width: containerBounds.width,
        height: containerBounds.height,
      },
      pet: { width: petBounds.width, height: petBounds.height },
      grabOffset: {
        x: event.clientX - petBounds.left,
        y: event.clientY - petBounds.top,
      },
      directionAnchorX: event.clientX,
    };
    draggingRef.current = true;
    setDragging(true);
    setLookDirection(null);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const session = dragSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    event.preventDefault();

    const nextDirection = grayDangoDragDirection(
      event.clientX - session.directionAnchorX,
      dragDirectionRef.current,
    );
    if (
      Math.abs(event.clientX - session.directionAnchorX) >=
      GRAYDANGO_DIRECTION_DEADZONE
    ) {
      session.directionAnchorX = event.clientX;
    }
    if (nextDirection !== dragDirectionRef.current) {
      dragDirectionRef.current = nextDirection;
      setDragDirection(nextDirection);
    }
    schedulePosition(
      grayDangoPositionForPointer(
        { x: event.clientX, y: event.clientY },
        session.container,
        session.pet,
        session.grabOffset,
      ),
    );
  };

  const finishDrag = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const session = dragSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    dragSessionRef.current = null;
    draggingRef.current = false;
    if (positionFrameRef.current !== null) {
      window.cancelAnimationFrame(positionFrameRef.current);
      positionFrameRef.current = null;
    }
    pendingPositionRef.current = null;
    setPosition(positionRef.current);
    setDragging(false);
    savePosition(positionRef.current);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const visibleRow =
    dragAnimation?.row ?? lookDirection?.row ?? presentation.row;
  const visibleFrame = dragAnimation ? frame : (lookDirection?.column ?? frame);

  const spriteStyle: SpriteStyle = {
    "--graydango-x": `calc(${visibleFrame * -24}px * var(--graydango-scale))`,
    "--graydango-y": `calc(${visibleRow * -26}px * var(--graydango-scale))`,
  };
  const petStyle: CSSProperties = {
    left: `${position.x * 100}%`,
    top: `${position.y * 100}%`,
    transform: `translate(${-position.x * 100}%, ${-position.y * 100}%)`,
  };

  return (
    <aside
      ref={petRef}
      className="graydango-pet"
      aria-label="GrayDango 项目助手"
      data-animation={activeAnimation}
      data-dragging={dragging || undefined}
      style={petStyle}
    >
      {presentation.bubble ? (
        <output
          className="graydango-pet__bubble"
          data-tone={presentation.tone}
          aria-live="polite"
        >
          {presentation.bubble}
        </output>
      ) : null}
      <span
        ref={spriteRef}
        className="graydango-pet__sprite"
        role="img"
        aria-label={`GrayDango：${activeAnimation}`}
        style={spriteStyle}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onLostPointerCapture={finishDrag}
      />
    </aside>
  );
}

export default memo(GrayDangoPet);
