// Applies the saved or system theme before first paint. Kept external for the CSP.
try {
  document.documentElement.dataset.theme =
    localStorage.getItem("sprung-fea-theme") ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
} catch {}
