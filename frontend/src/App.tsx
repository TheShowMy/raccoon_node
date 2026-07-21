import { useCallback, useEffect, useState } from "react";
import { bootstrapDomain } from "./api/bootstrap";
import { MainCanvas } from "./canvas/MainCanvas";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { useAppearanceStore } from "./store/appearanceStore";

/** 启动引导：加载快照 → 初始化领域投影 → 连接事件流（02 §9.1），失败可重试（02 §11） */
function useBootstrap(attempt: number): {
  ready: boolean;
  error: string | null;
} {
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    bootstrapDomain()
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);
  return { ready, error };
}

function BootScreen({
  error,
  onRetry,
}: {
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <main className="boot-screen">
      <section className="boot-screen__card" role={error ? "alert" : "status"}>
        <h1 className="px-font-pixel">RACCOON NODE</h1>
        {error ? (
          <>
            <p>快照加载失败：{error}</p>
            <button type="button" onClick={onRetry}>
              重试
            </button>
          </>
        ) : (
          <p>正在加载项目快照…</p>
        )}
      </section>
    </main>
  );
}

export function App() {
  // 明暗偏好（FE-SET-003）：system 时跟随 prefers-color-scheme
  const themePreference = useAppearanceStore((state) => state.theme);
  const density = useAppearanceStore((state) => state.density);
  const systemDark = useMediaQuery("(prefers-color-scheme: dark)");
  const dark =
    themePreference === "system" ? systemDark : themePreference === "dark";
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    // pxlkit 组件使用 .dark class 切换暗色（02 §10 像素 token 双套色板）
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  useEffect(() => {
    document.documentElement.dataset.density = density;
  }, [density]);

  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((count) => count + 1), []);
  const { ready, error } = useBootstrap(attempt);

  if (!ready) {
    return <BootScreen error={error} onRetry={retry} />;
  }

  return (
    <ErrorBoundary title="Raccoon Node">
      <MainCanvas />
    </ErrorBoundary>
  );
}
