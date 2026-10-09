/** Next.js startup hook: starts the background document worker in the Node.js server runtime. */
export async function register() {
  // The literal check lets Next strip the Node-only import from the edge bundle.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
