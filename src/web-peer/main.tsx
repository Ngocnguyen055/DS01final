import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles/style.css";
import "./styles/panels.css";
import "./styles/workspace.css";

createRoot(document.getElementById("root")!).render(<App />);
