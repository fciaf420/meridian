import { Toaster } from "sonner";

export default function ToastProvider() {
  return (
    <Toaster
      position="bottom-right"
      toastOptions={{
        style: {
          background: "#124559",
          border: "1px solid rgba(89, 131, 146, 0.3)",
          color: "#eff6e0",
          fontFamily: "'IBM Plex Sans', sans-serif",
        },
      }}
    />
  );
}
