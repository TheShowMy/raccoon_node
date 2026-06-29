import React, { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

interface SimpleSelectOption {
  value: string;
  label: string;
}

interface SimpleSelectProps {
  value: string | null;
  options: SimpleSelectOption[];
  disabled?: boolean;
  placeholder?: string;
  onChange: (value: string) => void;
}

export default function SimpleSelect({
  value,
  options,
  disabled = false,
  placeholder = "选择",
  onChange,
}: SimpleSelectProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(() =>
    options.findIndex((option) => option.value === value),
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const triggerId = useId();

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selectedLabel = options[selectedIndex]?.label ?? placeholder;

  useEffect(() => {
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
  }, [selectedIndex]);

  useEffect(() => {
    if (!open) return;

    function handleClickOutside(event: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [open]);

  function selectOption(index: number) {
    const option = options[index];
    if (!option) return;

    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function handleTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;

    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
      case "Enter":
      case " ":
        event.preventDefault();
        if (!open) {
          setOpen(true);
        } else if (event.key === "Enter" || event.key === " ") {
          selectOption(activeIndex);
        }
        break;
      case "Escape":
        event.preventDefault();
        setOpen(false);
        break;
      default:
        break;
    }
  }

  function handleListKeyDown(event: React.KeyboardEvent<HTMLUListElement>) {
    event.preventDefault();

    switch (event.key) {
      case "ArrowDown":
        setActiveIndex((prev) =>
          prev >= options.length - 1 ? options.length - 1 : prev + 1,
        );
        break;
      case "ArrowUp":
        setActiveIndex((prev) => (prev <= 0 ? 0 : prev - 1));
        break;
      case "Home":
        setActiveIndex(0);
        break;
      case "End":
        setActiveIndex(options.length - 1);
        break;
      case "Enter":
      case " ":
        selectOption(activeIndex);
        break;
      case "Escape":
        setOpen(false);
        triggerRef.current?.focus();
        break;
      default:
        break;
    }
  }

  return (
    <div
      ref={containerRef}
      className={`simple-select ${open ? "simple-select--open" : ""} ${disabled ? "simple-select--disabled" : ""}`}
    >
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={handleTriggerKeyDown}
        className="simple-select__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
      >
        <span>{selectedLabel}</span>
        <ChevronDown size={14} />
      </button>
      {open ? (
        <ul
          id={listId}
          className="simple-select__dropdown"
          role="listbox"
          aria-labelledby={triggerId}
          tabIndex={-1}
          onKeyDown={handleListKeyDown}
        >
          {options.map((option, index) => {
            const isSelected = option.value === value;
            const isActive = index === activeIndex;

            return (
              <li
                key={option.value}
                role="option"
                aria-selected={isSelected}
                className={isActive ? "is-active" : undefined}
              >
                <button
                  type="button"
                  className={isSelected ? "is-selected" : undefined}
                  onClick={() => selectOption(index)}
                  onMouseEnter={() => setActiveIndex(index)}
                >
                  <span>{option.label}</span>
                  {isSelected ? <Check size={14} /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
