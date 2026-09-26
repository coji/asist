/** An image imported with ?inline, which Vite turns into a data: URL in the bundle. */
declare module '*.png?inline' {
  const dataUrl: string
  export default dataUrl
}
