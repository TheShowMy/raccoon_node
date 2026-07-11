import { memo, useEffect, useRef, useState, type CSSProperties } from "react";
import { Card } from "@astryxdesign/core/Card";
import type { StartNodeData } from "../../types/api";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import {
  deriveGrayDangoPresentation,
  grayDangoDirectionCell,
  type GrayDangoDirectionCell,
} from "./graydangoModel";

type ChatData = Extract<StartNodeData, { kind: "requirement-chat" }>;
type SpriteStyle = CSSProperties & {
  "--graydango-x": string;
  "--graydango-y": string;
};

function GrayDangoPet({ data }: { data: ChatData }) {
  const presentation = deriveGrayDangoPresentation(data);
  const [frame, setFrame] = useState(0);
  const [direction, setDirection] = useState<GrayDangoDirectionCell | null>(
    null,
  );
  const spriteRef = useRef<HTMLSpanElement>(null);
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");

  useEffect(() => {
    setFrame(0);
    if (reduceMotion) return;
    const interval = window.setInterval(
      () => setFrame((current) => (current + 1) % presentation.frames),
      180,
    );
    return () => window.clearInterval(interval);
  }, [presentation.animation, presentation.frames, reduceMotion]);

  useEffect(() => {
    if (presentation.animation !== "idle") {
      setDirection(null);
      return;
    }
    let animationFrame = 0;
    const onPointerMove = (event: PointerEvent) => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        const bounds = spriteRef.current?.getBoundingClientRect();
        if (!bounds) return;
        const centerX = bounds.left + bounds.width / 2;
        const centerY = bounds.top + bounds.height / 2;
        setDirection(
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

  const visibleRow = direction?.row ?? presentation.row;
  const visibleFrame = direction?.column ?? frame;

  const spriteStyle: SpriteStyle = {
    "--graydango-x": `calc(var(--spacing-1) * ${visibleFrame * -24})`,
    "--graydango-y": `calc(var(--spacing-1) * ${visibleRow * -26})`,
  };

  return (
    <aside
      className="graydango-pet"
      aria-label="GrayDango 项目助手"
      data-animation={presentation.animation}
    >
      {presentation.bubble ? (
        <Card
          padding={2}
          className="graydango-pet__bubble"
          data-tone={presentation.tone}
        >
          <output aria-live="polite">{presentation.bubble}</output>
        </Card>
      ) : null}
      <span
        ref={spriteRef}
        className="graydango-pet__sprite"
        role="img"
        aria-label={`GrayDango：${presentation.animation}`}
        style={spriteStyle}
      />
    </aside>
  );
}

export default memo(GrayDangoPet);
