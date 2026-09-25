// Bundled as binary (wrangler.jsonc "rules": Data) — the module is an ArrayBuffer.
declare module '*.png' {
  const content: ArrayBuffer;
  export default content;
}
declare module '*.woff2' {
  const content: ArrayBuffer;
  export default content;
}
