import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { SettingsPage } from "../../types/api";
import SettingsLayout from "./SettingsLayout";

const listeners = new Set<(event: MediaQueryListEvent) => void>();

vi.stubGlobal("matchMedia", (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: (
    _event: string,
    listener: (event: MediaQueryListEvent) => void,
  ) => {
    listeners.add(listener);
  },
  removeEventListener: (
    _event: string,
    listener: (event: MediaQueryListEvent) => void,
  ) => {
    listeners.delete(listener);
  },
  dispatchEvent: (event: MediaQueryListEvent) => {
    listeners.forEach((listener) => listener(event));
    return true;
  },
}));

function renderLayout(page: SettingsPage = "basic", onChangePage = vi.fn()) {
  return render(
    <SettingsLayout
      page={page}
      onChangePage={onChangePage}
      basicPanel={<div data-testid="basic-panel" />}
      modelsPanel={<div data-testid="models-panel" />}
      navItemProps={{
        models: { "data-model-setup-target": "models" },
      }}
    />,
  );
}

it("renders sidebar navigation with settings categories", () => {
  renderLayout();

  expect(screen.getByRole("button", { name: "基础设置" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "模型设置" })).toBeInTheDocument();
  expect(screen.getByTestId("basic-panel")).toBeInTheDocument();
  expect(screen.queryByTestId("models-panel")).not.toBeInTheDocument();
});

it("switches pages when clicking sidebar items", () => {
  const onChangePage = vi.fn();
  renderLayout("basic", onChangePage);

  fireEvent.click(screen.getByRole("button", { name: "模型设置" }));
  expect(onChangePage).toHaveBeenCalledWith("models");
});

it("exposes custom data attributes on sidebar items", () => {
  renderLayout("models");

  expect(
    document.querySelector('[data-model-setup-target="models"]'),
  ).toBeInTheDocument();
});

it("renders the models panel when page is models", () => {
  renderLayout("models");

  expect(screen.getByTestId("models-panel")).toBeInTheDocument();
  expect(screen.queryByTestId("basic-panel")).not.toBeInTheDocument();
});
