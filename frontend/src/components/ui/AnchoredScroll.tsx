import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { ArrowDown } from "lucide-react";

export default function AnchoredScroll({
  children,
  version,
  className,
}: {
  children: ReactNode;
  version: string | number;
  className: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [unread, setUnread] = useState(false);

  function scrollToBottom() {
    const element = ref.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    pinnedRef.current = true;
    setUnread(false);
  }

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (pinnedRef.current) scrollToBottom();
      else setUnread(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [version]);

  return (
    <div className="anchored-scroll">
      <div
        ref={ref}
        className={className}
        onScroll={() => {
          const element = ref.current;
          if (!element) return;
          pinnedRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            48;
          if (pinnedRef.current) setUnread(false);
        }}
      >
        {children}
      </div>
      {unread ? (
        <Button
          label={"\u6709\u65b0\u6d88\u606f"}
          size="sm"
          variant="secondary"
          icon={<ArrowDown size={13} />}
          className="anchored-scroll__new"
          onClick={scrollToBottom}
        >
          有新消息
        </Button>
      ) : null}
    </div>
  );
}
