import type React from "react";

export function stopWheelPropagation(event: React.WheelEvent) {
  event.stopPropagation();
}
