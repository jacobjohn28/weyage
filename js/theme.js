import { state } from "./state.js";

export function applyTheme(theme) {
  document.body.setAttribute("data-theme", theme);
  state.theme = theme;
  const sun = document.getElementById("theme-icon-sun");
  const moon = document.getElementById("theme-icon-moon");
  sun.style.display = theme === "light" ? "none" : "";
  moon.style.display = theme === "light" ? "" : "none";
  // Update PWA theme-color
  const meta = document.querySelector('meta[name="theme-color"]:not([media])');
  if (meta) meta.setAttribute("content", theme === "dark" ? "#0F0F10" : "#FBFBFA");
}

export function initTheme() {
  const stored = localStorage.getItem("trip-theme");
  if (stored === "light" || stored === "dark") {
    applyTheme(stored);
  } else {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    applyTheme(prefersDark ? "dark" : "light");
  }
  // Listen for OS theme changes if user hasn't manually chosen
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    if (!localStorage.getItem("trip-theme")) {
      applyTheme(e.matches ? "dark" : "light");
    }
  });

  document.getElementById("theme-toggle").addEventListener("click", () => {
    const next = state.theme === "light" ? "dark" : "light";
    localStorage.setItem("trip-theme", next);
    applyTheme(next);
  });
}
