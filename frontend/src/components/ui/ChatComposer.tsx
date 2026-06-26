import { useLayoutEffect, useRef } from "react";
import { Send, Square } from "lucide-react";

const MAX_TEXTAREA_HEIGHT = 156;

export default function ChatComposer({
  value,
  disabled,
  canSend,
  placeholder,
  sendLabel = "发送",
  stopLabel = "停止",
  onChange,
  onSubmit,
  onStop,
}: {
  value: string;
  disabled: boolean;
  canSend: boolean;
  placeholder: string;
  sendLabel?: string;
  stopLabel?: string;
  onChange: (value: string) => void;
  onSubmit: () => void | Promise<void>;
  onStop?: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const running = Boolean(onStop);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const height = Math.min(
      Math.max(textarea.scrollHeight, 42),
      MAX_TEXTAREA_HEIGHT,
    );
    textarea.style.height = `${height}px`;
    textarea.style.overflowY =
      textarea.scrollHeight > MAX_TEXTAREA_HEIGHT ? "auto" : "hidden";
  }, [value]);

  function submit() {
    if (canSend) void onSubmit();
  }

  return (
    <form
      className="rq-composer nowheel nodrag"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={textareaRef}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          const composing =
            event.nativeEvent.isComposing || event.keyCode === 229;
          if (event.key !== "Enter" || event.shiftKey || composing) return;
          event.preventDefault();
          submit();
        }}
        placeholder={placeholder}
        rows={1}
      />
      {running ? (
        <button
          type="button"
          className="rq-composer__stop"
          onClick={onStop}
          aria-label={stopLabel}
          title={stopLabel}
        >
          <Square size={15} fill="currentColor" />
        </button>
      ) : (
        <button type="submit" disabled={!canSend} aria-label={sendLabel}>
          <Send size={15} />
        </button>
      )}
    </form>
  );
}
