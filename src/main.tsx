import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./i18n";
import App from "./App";
import { RuntimeRootBoundary } from "./components/layout/RuntimeRootBoundary";
import { storageManager } from "./lib/storage/storage";

const root = createRoot(document.getElementById("root")!);

void storageManager.ready().then(
  () => {
    root.render(
      <StrictMode>
        <RuntimeRootBoundary>
          <App />
        </RuntimeRootBoundary>
      </StrictMode>,
    );
  },
  (error: unknown) => {
    const message =
      error instanceof Error
        ? error.message
        : "Persistent browser storage could not be prepared.";
    root.render(
      <StrictMode>
        <main role="alert">
          <h1>Local data could not be opened safely</h1>
          <p>{message}</p>
          <p>
            Existing data was not overwritten. Fix storage access and reload.
          </p>
        </main>
      </StrictMode>,
    );
  },
);
