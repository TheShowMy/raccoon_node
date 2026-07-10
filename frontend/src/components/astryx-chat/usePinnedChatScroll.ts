import {
  useCallback,
  useEffect,
  useRef,
  type UIEvent,
  type WheelEvent,
} from "react";

const LOCK_THRESHOLD = 12;

export function usePinnedChatScroll() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lockedRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const frameRef = useRef<number | null>(null);
  const prependHeightRef = useRef<number | null>(null);

  const updateLockFromScroll = useCallback((element: HTMLDivElement) => {
    const distance =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    if (element.scrollTop < lastScrollTopRef.current - 0.5) {
      lockedRef.current = false;
    }
    if (distance <= LOCK_THRESHOLD) {
      lockedRef.current = true;
    }
    lastScrollTopRef.current = element.scrollTop;
  }, []);

  const onScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      updateLockFromScroll(event.currentTarget);
    },
    [updateLockFromScroll],
  );

  const onWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) lockedRef.current = false;
  }, []);

  const onTouchMove = useCallback(() => {
    lockedRef.current = false;
  }, []);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const handleScroll = () => updateLockFromScroll(element);
    const handleWheel = (event: globalThis.WheelEvent) => {
      if (event.deltaY < 0) lockedRef.current = false;
    };
    const handleTouchMove = () => {
      lockedRef.current = false;
    };
    element.addEventListener("scroll", handleScroll);
    element.addEventListener("wheel", handleWheel, { passive: true });
    element.addEventListener("touchmove", handleTouchMove, { passive: true });
    return () => {
      element.removeEventListener("scroll", handleScroll);
      element.removeEventListener("wheel", handleWheel);
      element.removeEventListener("touchmove", handleTouchMove);
    };
  }, [updateLockFromScroll]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
      }
    },
    [],
  );

  const onContentChange = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const element = scrollRef.current;
      if (!element) return;

      if (prependHeightRef.current !== null) {
        const delta = element.scrollHeight - prependHeightRef.current;
        prependHeightRef.current = null;
        if (delta > 0) {
          element.scrollTop += delta;
          lastScrollTopRef.current = element.scrollTop;
        }
        return;
      }

      if (!lockedRef.current) return;
      const target = Math.max(0, element.scrollHeight - element.clientHeight);
      if (target <= element.scrollTop + 0.5) return;
      element.scrollTop = target;
      lastScrollTopRef.current = target;
    });
  }, []);

  const prepareForPrepend = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    prependHeightRef.current = element.scrollHeight;
    lockedRef.current = false;
  }, []);

  const isPinned = useCallback(() => lockedRef.current, []);

  return {
    scrollRef,
    onScroll,
    onWheel,
    onTouchMove,
    onContentChange,
    prepareForPrepend,
    isPinned,
  };
}
