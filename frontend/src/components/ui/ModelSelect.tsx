import React, { useState, useRef, useEffect } from "react";
import { Check, ChevronDown } from "lucide-react";

type ModelSelectOption = {
  value: string;
  label: string;
};

type ModelSelectProps = {
  value: string;
  options: ModelSelectOption[];
  disabled?: boolean;
  placeholder?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onChange: (value: string) => void;
};

export default function ModelSelect({
  value,
  options,
  disabled,
  placeholder,
  open: openProp,
  onOpenChange,
  onChange,
}: ModelSelectProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : internalOpen;
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find((option) => option.value === value);
  const selectedLabel = selectedOption?.label ?? placeholder ?? "";

  function setOpen(nextOpen: boolean) {
    if (!isControlled) {
      setInternalOpen(nextOpen);
    }
    onOpenChange?.(nextOpen);
  }

  useEffect(() => {
    if (open) {
      const index = options.findIndex((option) => option.value === value);
      setHighlightedIndex(index >= 0 ? index : 0);
    }
  }, [open, options, value]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as globalThis.Node)
      ) {
        setOpen(false);
      }
    }

    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [open]);

  function toggle() {
    if (!disabled) {
      setOpen(!open);
    }
  }

  function select(option: ModelSelectOption) {
    onChange(option.value);
    setOpen(false);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (disabled) {
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open && options[highlightedIndex]) {
        select(options[highlightedIndex]);
      } else {
        setOpen(true);
      }
    } else if (event.key === "Escape") {
      setOpen(false);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
      } else {
        setHighlightedIndex((previous) => (previous + 1) % options.length);
      }
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
      } else {
        setHighlightedIndex(
          (previous) => (previous - 1 + options.length) % options.length,
        );
      }
    }
  }

  return (
    <div className="model-select" ref={containerRef}>
      <button
        type="button"
        className={`model-select__trigger ${
          open ? "model-select__trigger--open" : ""
        }`}
        disabled={disabled}
        onClick={toggle}
        onKeyDown={handleKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{selectedLabel}</span>
        <ChevronDown size={14} />
      </button>
      {open ? (
        <ul className="model-select__dropdown" role="listbox">
          {options.map((option, index) => (
            <li
              key={option.value}
              className={`model-select__option ${
                option.value === value ? "model-select__option--selected" : ""
              } ${
                index === highlightedIndex
                  ? "model-select__option--highlighted"
                  : ""
              }`}
              role="option"
              aria-selected={option.value === value}
              onClick={() => select(option)}
              onMouseEnter={() => setHighlightedIndex(index)}
            >
              {option.value === value ? <Check size={14} /> : null}
              <span>{option.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
