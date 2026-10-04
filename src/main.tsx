import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import AppErrorBoundary from "./components/AppErrorBoundary";

createRoot(document.getElementById("root")!).render(
  <AppErrorBoundary>
    <App />
  </AppErrorBoundary>,
);

// Registration cannot block login; unsupported browsers keep using the website.
if (
  import.meta.env.PROD &&
  "serviceWorker" in navigator &&
  window.isSecureContext
) {
  void navigator.serviceWorker
    .register("/sw.js", { scope: "/", updateViaCache: "none" })
    .catch(() => {
      window.dispatchEvent(new Event("pos-pwa-unavailable"));
    });
}
