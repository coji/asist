/** An image imported with ?inline, which Vite turns into a data: URL in the bundle. */
declare module '*.png?inline' {
  const dataUrl: string
  export default dataUrl
}

/** A text file imported with ?raw, which Vite turns into a string in the bundle. */
declare module '*.md?raw' {
  const text: string
  export default text
}
