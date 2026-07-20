import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { PixelButton } from "@pxlkit/ui-kit";

interface ErrorBoundaryProps {
  children: ReactNode;
  title: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(
      `[ErrorBoundary:${this.props.title}]`,
      error,
      info.componentStack,
    );
  }

  render() {
    if (this.state.error) {
      return (
        <section
          className="error-boundary px-cut px-shadowed-sm"
          role="alert"
          aria-label={`${this.props.title}加载失败`}
        >
          <header className="error-boundary__header">
            <span className="px-font-pixel">{this.props.title}</span>
          </header>
          <p className="error-boundary__message">
            渲染出错：{this.state.error.message}
          </p>
          <footer className="error-boundary__actions">
            <PixelButton
              size="sm"
              variant="outline"
              onClick={() => this.setState({ error: null })}
            >
              重试
            </PixelButton>
          </footer>
        </section>
      );
    }
    return this.props.children;
  }
}
