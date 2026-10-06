import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./style.css";
class ErrorBoundary extends React.Component<
  React.PropsWithChildren,
  { error?: string }
> {
  state: { error?: string } = {};
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <main className="fatal">
        <h1>WRET could not render this view</h1>
        <p>{this.state.error}</p>
        <p>
          Your last saved project remains in this browser. Reload to restore it.
        </p>
        <button onClick={() => location.reload()}>Reload workbench</button>
      </main>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
