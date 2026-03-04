import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";
import { CardThemeProvider } from "./components/CardThemeContext";


ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <CardThemeProvider>
        <App />
      </CardThemeProvider>
    </BrowserRouter>
  </React.StrictMode>
);