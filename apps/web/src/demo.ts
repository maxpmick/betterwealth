export function isDemoMode() {
  return typeof window !== "undefined" && window.sessionStorage.getItem("bw-demo") === "true";
}
