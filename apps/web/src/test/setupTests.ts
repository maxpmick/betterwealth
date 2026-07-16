import { createElement } from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(window, "ResizeObserver", { configurable: true, value: ResizeObserverMock });
Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  value: ResizeObserverMock,
});
Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });

vi.mock("@mui/x-charts/LineChart", () => ({
  LineChart: ({ height }: { height?: number }) =>
    createElement("div", {
      role: "img",
      "aria-label": "Financial trend chart",
      style: { height: `${height ?? 240}px` },
    }),
}));

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});
